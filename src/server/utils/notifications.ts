import { sendDiscordNotification } from './discord';
import { sendWebhookNotification } from './webhook';
import { sendTelegramNotification } from './telegram';

/** Send to every configured channel, true when at least one accepted the message */
export async function sendNotification(
  message: string,
  title = 'HiCheck',
  tags?: string[],
): Promise<boolean> {
  const sent = await Promise.all([
    sendWebhookNotification(message, title, tags),
    sendDiscordNotification(message, title),
    sendTelegramNotification(message, title),
  ]);
  return sent.some(Boolean);
}
