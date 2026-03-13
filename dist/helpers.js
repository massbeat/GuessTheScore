"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TARGET_GROUP_ID = exports.ADMIN_IDS = void 0;
exports.isAdmin = isAdmin;
exports.isMatchLocked = isMatchLocked;
exports.formatKickoff = formatKickoff;
exports.formatMatchLine = formatMatchLine;
exports.checkGroupMembership = checkGroupMembership;
exports.displayName = displayName;
exports.escapeHtml = escapeHtml;
exports.sendPrivate = sendPrivate;
exports.sendPrivateWithMarkup = sendPrivateWithMarkup;
exports.ADMIN_IDS = (process.env.ADMIN_IDS || '')
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id));
exports.TARGET_GROUP_ID = process.env.TARGET_GROUP_ID
    ? parseInt(process.env.TARGET_GROUP_ID, 10)
    : null;
function isAdmin(telegramId) {
    return exports.ADMIN_IDS.includes(telegramId);
}
function isMatchLocked(kickoffTime) {
    const kickoff = new Date(kickoffTime).getTime();
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;
    return now >= kickoff - fiveMinutes;
}
function formatKickoff(kickoffTime) {
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
function formatMatchLine(match) {
    const locked = isMatchLocked(match.kickoff_time);
    const lockIcon = locked ? '🔒' : '🟢';
    return `${lockIcon} [${match.id}] ${match.home_team} vs ${match.away_team}\n   📅 ${formatKickoff(match.kickoff_time)}\n   🏆 ${match.league}`;
}
async function checkGroupMembership(ctx, telegramId) {
    if (!exports.TARGET_GROUP_ID)
        return true; // If not configured, allow everyone
    try {
        const member = await ctx.telegram.getChatMember(exports.TARGET_GROUP_ID, telegramId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    }
    catch {
        return false;
    }
}
function displayName(user) {
    return user.username ? `@${user.username}` : user.first_name || `User${user.telegram_id}`;
}
// Escapes special HTML characters to prevent Telegram parse errors
function escapeHtml(text) {
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
async function sendPrivate(ctx, telegramId, text, extra) {
    try {
        return await ctx.telegram.sendMessage(telegramId, text, extra);
    }
    catch (err) {
        // 403 = user hasn't started a private chat with the bot
        if (err?.response?.error_code === 403) {
            await ctx.reply(`💬 Please start a private chat with me first so I can send you responses!\n` +
                `Tap my name and press <b>Start</b>, then try again.`, { parse_mode: 'HTML' });
        }
        return null;
    }
}
/**
 * Send a message with inline keyboard to the user's private chat.
 * Similar to sendPrivate but supports Markup keyboards for buttons.
 */
async function sendPrivateWithMarkup(ctx, telegramId, text, extra) {
    try {
        return await ctx.telegram.sendMessage(telegramId, text, extra);
    }
    catch (err) {
        if (err?.response?.error_code === 403) {
            await ctx.reply(`💬 Please start a private chat with me first so I can send you responses!\n` +
                `Tap my name and press <b>Start</b>, then try again.`, { parse_mode: 'HTML' });
        }
        return null;
    }
}
