import Logger from './logger';

const log = new Logger('telegram');

/** Send a message to the configured Telegram chat via a Bot API token */
export async function sendTelegramNotification(
  message: string,
  title = 'HiCheck',
): Promise<boolean> {
  const token = process.env['TELEGRAM_BOT_TOKEN']?.trim();
  const chatId = process.env['TELEGRAM_CHAT_ID']?.trim();
  if (!token || !chatId) {
    log.info('Telegram notification skipped (missing config)');
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const text = `*${title}*\n${message}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed with status ${res.status}: ${await res.text()}`);
    }
    log.info(`Telegram sent: ${title} - ${message}`);
    return true;
  } catch (err) {
    log.error(`Telegram failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
