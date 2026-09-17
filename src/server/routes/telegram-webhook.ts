import { defineEventHandler, readBody } from 'h3';
import { getInternalBaseUrl } from '../utils/base-url';
import { sendTelegramRaw } from '../utils/telegram';
import Logger from '../utils/logger';

const log = new Logger('telegram-webhook');

function getEnvVar(name: string): string {
  return process.env[name] || (import.meta.env && import.meta.env[name]) || '';
}

async function callPgExecutor<T>(endpoint: string, query: string): Promise<T[]> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  return data.data || [];
}

/** Runs a fresh live check across every domain, blocking until it's done */
async function runLiveMonitor(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/domain-monitor`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`domain-monitor failed with status ${res.status}`);
  }
}

async function buildStatusReport(pgUrl: string): Promise<string> {
  const [totalRow] = await callPgExecutor<{ total: string }>(
    pgUrl,
    'SELECT count(*) AS total FROM domains;',
  );
  const total = totalRow?.total ?? '0';

  const latest = await callPgExecutor<{ domain_name: string; is_up: boolean }>(
    pgUrl,
    `SELECT DISTINCT ON (u.domain_id) d.domain_name, u.is_up
     FROM uptime u JOIN domains d ON d.id = u.domain_id
     ORDER BY u.domain_id, u.checked_at DESC`,
  );
  const upCount = latest.filter((d) => d.is_up).length;
  const downList = latest.filter((d) => !d.is_up).map((d) => d.domain_name);

  const expiring = await callPgExecutor<{ domain_name: string; days: number }>(
    pgUrl,
    `SELECT domain_name, (expiry_date - CURRENT_DATE) AS days
     FROM domains
     WHERE expiry_date IS NOT NULL AND expiry_date - CURRENT_DATE <= 30
     ORDER BY expiry_date;`,
  );

  const [notifRow] = await callPgExecutor<{ recent: string }>(
    pgUrl,
    "SELECT count(*) AS recent FROM notifications WHERE created_at > now() - interval '12 hours';",
  );
  const recent = notifRow?.recent ?? '0';

  const now = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Tehran', hour12: false })
    .slice(0, 16);

  let msg =
    `🕐 *HiCheck Status* — ${now} (Tehran)\n━━━━━━━━━━━━━━━\n` +
    `📊 Domains: *${total}* total\n` +
    `✅ Up: *${upCount}*   ❌ Down: *${latest.length - upCount}*`;

  if (downList.length) {
    msg += `\n\n*Down:*\n${downList.map((d) => `• ${d}`).join('\n')}`;
  }
  if (expiring.length) {
    msg += `\n\n*Expiring within 30 days:*\n${expiring
      .map((d) => `• ${d.domain_name} (${d.days}d)`)
      .join('\n')}`;
  }
  msg += `\n\n🔔 Notifications (last 12h): *${recent}*`;

  return msg;
}

/**
 * Telegram webhook: replies to /check (or /status) with an on-demand
 * status snapshot. Nginx bypasses Basic Auth for this path, so this
 * handler is the only thing standing between the public internet and
 * our DB — it must verify both the webhook secret and the chat id.
 */
export default defineEventHandler(async (event) => {
  const secret = getEnvVar('TELEGRAM_WEBHOOK_SECRET');
  const headerSecret = event.node.req.headers['x-telegram-bot-api-secret-token'];
  if (!secret || headerSecret !== secret) {
    event.node.res.statusCode = 401;
    return { error: 'unauthorized' };
  }

  const body = await readBody(event).catch(() => null);
  const message = body?.message;
  const chatId = message?.chat?.id != null ? String(message.chat.id) : '';
  const text = (message?.text || '').trim().toLowerCase();

  const allowedChatId = getEnvVar('TELEGRAM_CHAT_ID');
  if (!message || !allowedChatId || chatId !== allowedChatId) {
    return { ok: true };
  }

  if (text === '/check' || text === '/status') {
    const baseUrl = getInternalBaseUrl(event);
    const pgUrl = `${baseUrl}/api/pg-executer`;

    // Ack fast so Telegram doesn't time out and retry the update, then do
    // the (slow, ~30-60s for ~100 domains) live check in the background.
    await sendTelegramRaw('🔄 Running a live check on all domains, this takes a minute…');

    (async () => {
      try {
        await runLiveMonitor(baseUrl);
        const report = await buildStatusReport(pgUrl);
        await sendTelegramRaw(report);
      } catch (err) {
        log.error(`Failed to build status report: ${err instanceof Error ? err.message : String(err)}`);
        await sendTelegramRaw('⚠️ Failed to build status report, check server logs.');
      }
    })();
  }

  return { ok: true };
});
