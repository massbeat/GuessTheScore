import { Context } from 'telegraf';

export const ADMIN_IDS: number[] = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((id) => parseInt(id.trim(), 10))
  .filter((id) => !isNaN(id));

export const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID
  ? parseInt(process.env.TARGET_GROUP_ID, 10)
  : null;

export function isAdmin(telegramId: number): boolean {
  return ADMIN_IDS.includes(telegramId);
}

export function isMatchLocked(kickoffTime: string): boolean {
  const kickoff = new Date(kickoffTime).getTime();
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  return now >= kickoff - fiveMinutes;
}

export function formatKickoff(kickoffTime: string): string {
  const date = new Date(kickoffTime);
  return date.toLocaleString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }) + ' UTC';
}

export function formatMatchLine(match: any): string {
  const locked = isMatchLocked(match.kickoff_time);
  const lockIcon = locked ? '🔒' : '🟢';
  return `${lockIcon} [${match.id}] ${match.home_team} vs ${match.away_team}\n   📅 ${formatKickoff(match.kickoff_time)}\n   🏆 ${match.league}`;
}

export async function checkGroupMembership(ctx: Context, telegramId: number): Promise<boolean> {
  if (!TARGET_GROUP_ID) return true; // If not configured, allow everyone

  try {
    const member = await ctx.telegram.getChatMember(TARGET_GROUP_ID, telegramId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch {
    return false;
  }
}

export function displayName(user: any): string {
  return user.username ? `@${user.username}` : user.first_name || `User${user.telegram_id}`;
}


// Escapes special HTML characters to prevent Telegram parse errors
export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Send a message to the user's private chat instead of replying in the group.
 * If the user hasn't started a private chat with the bot, sends a brief
 * nudge in the group telling them to DM the bot first.
 * Returns the sent message, or null if the DM failed.
 */
export async function sendPrivate(
  ctx: Context,
  telegramId: number,
  text: string,
  extra?: any
): Promise<any> {
  try {
    return await ctx.telegram.sendMessage(telegramId, text, extra);
  } catch (err: any) {
    // 403 = user hasn't started a private chat with the bot
    if (err?.response?.error_code === 403) {
      await ctx.reply(
        `💬 Please start a private chat with me first so I can send you responses!\n` +
        `Tap my name and press <b>Start</b>, then try again.`,
        { parse_mode: 'HTML' }
      );
    }
    return null;
  }
}

/**
 * Send a message with inline keyboard to the user's private chat.
 * Similar to sendPrivate but supports Markup keyboards for buttons.
 */
export async function sendPrivateWithMarkup(
  ctx: Context,
  telegramId: number,
  text: string,
  extra: any
): Promise<any> {
  try {
    return await ctx.telegram.sendMessage(telegramId, text, extra);
  } catch (err: any) {
    if (err?.response?.error_code === 403) {
      await ctx.reply(
        `💬 Please start a private chat with me first so I can send you responses!\n` +
        `Tap my name and press <b>Start</b>, then try again.`,
        { parse_mode: 'HTML' }
      );
    }
    return null;
  }
}
