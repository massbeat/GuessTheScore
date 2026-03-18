import { Telegraf, Markup } from 'telegraf';
import {
  upsertUser,
  getActiveMatches,
  getMatch,
  upsertPrediction,
  getUserPredictions,
  getAllUserPredictionsWithGroups,
  getLastResultsPredictions,
  getGlobalLeaderboard,
  getGroupLeaderboard,
  getUser,
  getUnpredictedMatches,
  getPredictedMatches,
  getUserGroups,
  hasAnyGroupMembership,
  joinGroup,
  registerGroup,
} from './database';
import {
  checkGroupMembership,
  isMatchLocked,
  formatKickoff,
  displayName,
  escapeHtml,
  isAdmin,
  sendPrivate,
} from './helpers';
import { pointsLabel } from './scoring';

// In-memory state for the predict conversation flow
// Maps telegramId -> {matchId, groupId} they are currently predicting for
const pendingPrediction: Map<number, { matchId: number; groupId: number }> = new Map();

function formatMatchLineHtml(m: any): string {
  const locked = isMatchLocked(m.kickoff_time);
  const lockIcon = locked ? '🔒' : '🟢';
  return (
    `${lockIcon} <b>${escapeHtml(m.home_team)} vs ${escapeHtml(m.away_team)}</b>\n` +
    `   📅 ${formatKickoff(m.kickoff_time)}\n` +
    `   🏆 ${escapeHtml(m.league)}`
  );
}

const USER_HELP = (name: string) =>
  `👋 Welcome, <b>${name}</b>!\n\n` +
  `<b>📋 Commands:</b>\n\n` +
  `⚽ /matches — View open fixtures &amp; predict\n` +
  `📋 /missing — Matches you haven't predicted yet\n` +
  `✅ /mypicks — Your current predictions\n` +
  `📊 /mystats — Your points &amp; prediction history\n` +
  `🏆 /leaderboard — Group &amp; global leaderboard\n` +
  `❓ /help — Show this message\n\n` +
  `<b>🏆 Scoring:</b>\n` +
  `🎯 Exact score → <b>3 pts</b>\n` +
  `✅ Correct goal difference → <b>2 pts</b>\n` +
  `👍 Correct outcome → <b>1 pt</b>\n` +
  `❌ Wrong outcome → <b>0 pts</b>\n\n` +
  `<i>Predictions lock 5 minutes before kickoff.</i>\n\n` +
  `☕ <b>Enjoying the bot?</b> <a href="https://buymeacoffee.com/massbeat">Buy me a coffee!</a>`;

const ADMIN_HELP = (name: string) =>
  `👋 Welcome, <b>${name}</b>! You have <b>admin access</b>.\n\n` +
  `<b>👤 User Commands:</b>\n` +
  `⚽ /matches — View open fixtures &amp; predict\n` +
  `📋 /missing — Matches you haven't predicted yet\n` +
  `✅ /mypicks — Your current predictions\n` +
  `📊 /mystats — Your points &amp; prediction history\n` +
  `🏆 /leaderboard — Group &amp; global leaderboard\n` +
  `❓ /help — Show this help\n\n` +
  `<b>👑 Admin Commands:</b>\n\n` +
  `<b>📥 Fetching matches:</b>\n` +
  `• /admin_competitions — Browse all competitions (buttons)\n` +
  `• /admin_fetch &lt;code&gt; [matchday] — Fetch by code\n` +
  `  e.g. <code>/admin_fetch PL</code> or <code>/admin_fetch PL 28</code>\n\n` +
  `<b>🗂 Managing active matches:</b>\n` +
  `• /admin_active — List currently active matches\n` +
  `• /admin_groups — List registered groups\n\n` +
  `<b>✅ Finalizing results:</b>\n` +
  `• /admin_finalize_all — Score all finished unscored matches\n` +
  `• /admin_update &lt;match_id&gt; — Fetch score from API &amp; award points\n` +
  `• /admin_manual_score &lt;match_id&gt; &lt;home&gt;-&lt;away&gt; — Set score manually\n` +
  `  e.g. <code>/admin_manual_score 12345 2-1</code>\n\n` +
  `<b>🗑 Reset commands:</b>\n` +
  `• /admin_clearleaderboard — Delete all predictions &amp; reset scores\n` +
  `• /admin_clearmatchday — Deactivate all active matches\n` +
  `• /admin_resetfinished — Reset finished matches for reuse\n\n` +
  `<b>🏆 Free tier competition codes:</b>\n` +
  `<code>PL</code> Premier League  •  <code>CL</code> Champions League\n` +
  `<code>BL1</code> Bundesliga  •  <code>SA</code> Serie A\n` +
  `<code>PD</code> La Liga  •  <code>FL1</code> Ligue 1\n` +
  `<code>DED</code> Eredivisie  •  <code>PPL</code> Primeira Liga\n\n` +
  `☕ <b>Enjoying the bot?</b> <a href="https://buymeacoffee.com/massbeat">Buy me a coffee!</a>`;

export function registerUserCommands(bot: Telegraf): void {

  const isGroupChat = (ctx: any) =>
    ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

  const getChatGroupId = (ctx: any): number => ctx.chat!.id;

  const getChatGroupName = (ctx: any): string =>
    (ctx.chat as any)?.title || `Group ${ctx.chat?.id}`;

  // ─── Helper: auto-register group + join user (when in a group chat) ────────
  function autoRegisterGroupAndUser(ctx: any, userId: number, username: string | undefined, firstName: string): void {
    const groupId = getChatGroupId(ctx);
    const groupName = getChatGroupName(ctx);
    registerGroup(groupId, groupName);
    upsertUser(userId, username, firstName);
    joinGroup(userId, groupId);
  }

  // ─── Helper: resolve groupId for DM commands ────────────────────────────
  // If user is in 1 group → returns that groupId.
  // If user is in 2+ groups → sends group selection keyboard and returns null.
  // If user is in 0 groups → sends error and returns null.
  async function resolveGroupForDM(ctx: any, userId: number, action: string): Promise<number | null> {
    const groups = getUserGroups(userId);
    if (groups.length === 0) {
      await ctx.reply(
        `🚫 You are not a member of any competition group.\n\n` +
        `Ask an admin to invite you to a group where this bot is active, then use /start in that group.`
      );
      return null;
    }
    if (groups.length === 1) return groups[0].group_id;

    // Multiple groups: show selection keyboard
    const buttons = groups.map((g: any) => [
      Markup.button.callback(
        `🏆 ${escapeHtml(g.group_name || `Group ${g.group_id}`)}`,
        `gsel_${g.group_id}_${action}`
      ),
    ]);
    await ctx.reply(
      `🏆 <b>Select Competition</b>\n\nYou're in ${groups.length} competitions. Which one?`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
    );
    return null;
  }

  // ─── Helper: show open matches for a group (sends to DM) ─────────────────
  async function showMatchesForGroup(ctx: any, userId: number, groupId: number): Promise<void> {
    const matches = getActiveMatches();
    if (matches.length === 0) {
      await sendPrivate(ctx, userId, '📭 No matches are currently open for prediction.');
      return;
    }

    await sendPrivate(ctx, userId,
      `⚽ <b>Open Matches</b>\nClick a match to submit your prediction:`,
      { parse_mode: 'HTML' }
    );

    for (const m of matches) {
      const locked = isMatchLocked(m.kickoff_time);
      const matchInfo =
        `${locked ? '🔒' : '🟢'} <b>${escapeHtml(m.home_team)} vs ${escapeHtml(m.away_team)}</b>\n` +
        `📅 ${formatKickoff(m.kickoff_time)}\n` +
        `🏆 ${escapeHtml(m.league)}`;

      if (locked) {
        await sendPrivate(ctx, userId, matchInfo + '\n<i>Predictions locked</i>', { parse_mode: 'HTML' });
      } else {
        await sendPrivate(ctx, userId, matchInfo, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`🎯 Predict`, `predict_${m.id}_${groupId}`)],
          ]),
        });
      }
    }
  }

  // ─── Helper: show unpredicted matches for a group (sends to DM) ───────────
  async function showMissingForGroup(ctx: any, userId: number, groupId: number): Promise<void> {
    const matches = getUnpredictedMatches(userId, groupId);
    if (matches.length === 0) {
      await sendPrivate(ctx, userId, '✅ You\'re all caught up! You\'ve predicted every active match.');
      return;
    }

    await sendPrivate(ctx, userId,
      `📋 <b>Matches Without Your Prediction (${matches.length})</b>\nClick a match to predict:`,
      { parse_mode: 'HTML' }
    );

    for (const m of matches) {
      const locked = isMatchLocked(m.kickoff_time);
      const matchInfo =
        `${locked ? '🔒' : '🟢'} <b>${escapeHtml(m.home_team)} vs ${escapeHtml(m.away_team)}</b>\n` +
        `📅 ${formatKickoff(m.kickoff_time)}\n` +
        `🏆 ${escapeHtml(m.league)}`;

      if (locked) {
        await sendPrivate(ctx, userId, matchInfo + '\n<i>Predictions locked</i>', { parse_mode: 'HTML' });
      } else {
        await sendPrivate(ctx, userId, matchInfo, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`🎯 Predict`, `predict_${m.id}_${groupId}`)],
          ]),
        });
      }
    }
  }

  // ─── Helper: show all predictions across all groups ───────────────────────
  // One row per (match × group). Same match in 2 groups → 2 rows.
  async function showAllPicks(ctx: any, userId: number): Promise<void> {
    const picks = getAllUserPredictionsWithGroups(userId);
    if (picks.length === 0) {
      await sendPrivate(ctx, userId,
        '📭 You haven\'t made any predictions yet. Use /matches to get started!');
      return;
    }

    let text = `🎯 <b>Your Predictions</b>\n\n`;
    for (const p of picks) {
      const groupLabel = escapeHtml(p.group_name || (p.group_id ? `Group ${p.group_id}` : 'No group'));
      if (p.status === 'finished') {
        const pts = p.points_awarded !== null
          ? `<b>${p.points_awarded} pts</b> — ${pointsLabel(p.points_awarded)}`
          : '<i>not scored yet</i>';
        text += `⚽ <b>${escapeHtml(p.home_team)} ${p.actual_home_score}–${p.actual_away_score} ${escapeHtml(p.away_team)}</b>\n`;
        text += `   🏆 ${groupLabel} | Pick: <b>${p.predicted_home_score}-${p.predicted_away_score}</b> | ${pts}\n\n`;
      } else {
        const locked = isMatchLocked(p.kickoff_time);
        text += `${locked ? '🔒' : '🟢'} <b>${escapeHtml(p.home_team)} vs ${escapeHtml(p.away_team)}</b>\n`;
        text += `   📅 ${formatKickoff(p.kickoff_time)}\n`;
        text += `   🏆 ${groupLabel} | Pick: <b>${p.predicted_home_score}-${p.predicted_away_score}</b>`;
        text += locked ? '\n\n' : '  <i>(editable)</i>\n\n';
      }
    }
    await sendPrivate(ctx, userId, text, { parse_mode: 'HTML' });
  }

  // ─── Helper: show submitted predictions for a single group (kept for gsel callback) ──
  async function showPicksForGroup(ctx: any, userId: number, groupId: number): Promise<void> {
    // Now delegates to the all-groups view for a unified experience
    await showAllPicks(ctx, userId);
  }

  // ─── Helper: plain name for leaderboard (no @ so no Telegram notifications) ─
  function plainName(u: any): string {
    // Show username without @ prefix so Telegram doesn't create a mention/ping.
    // Fall back to first_name, then a generic ID label.
    return escapeHtml(u.username || u.first_name || `User${u.telegram_id}`);
  }

  // ─── Helper: format and send leaderboard ──────────────────────────────────
  async function sendLeaderboardMessage(ctx: any, board: any[], title: string): Promise<void> {
    if (board.length === 0) {
      await ctx.reply('🏆 No scores yet. Be the first to predict!');
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    let text = `🏆 <b>${title} (Top ${board.length})</b>\n\n`;
    board.forEach((u: any, i: number) => {
      const medal = medals[i] ?? `${i + 1}.`;
      text += `${medal} ${plainName(u)} — <b>${u.total_points} pts</b>\n`;
    });
    await ctx.reply(text, { parse_mode: 'HTML' });
  }

  // ─── /start ───────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    if (isGroupChat(ctx)) {
      // In a group: auto-register the group and the user
      autoRegisterGroupAndUser(ctx, user.id, user.username, user.first_name);
      const groupName = getChatGroupName(ctx);
      const name = escapeHtml(user.first_name);
      await ctx.reply(
        `⚽ <b>${name}</b> joined the prediction game for <b>${escapeHtml(groupName)}</b>!\n\n` +
        `Use /matches to see open fixtures and submit predictions.\n` +
        `You can also DM me directly for a private chat.`,
        { parse_mode: 'HTML' }
      );
    } else {
      // DM: register user (upsert only), then check group membership
      upsertUser(user.id, user.username, user.first_name);
      const name = escapeHtml(user.first_name);

      if (!isAdmin(user.id) && !checkGroupMembership(user.id)) {
        await ctx.reply(
          `👋 Hi <b>${name}</b>!\n\n` +
          `🚫 <b>Access Denied</b>\n\n` +
          `You must join a group where this bot is active and use /start there first.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      const msg = isAdmin(user.id) ? ADMIN_HELP(name) : USER_HELP(name);
      await ctx.reply(msg, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    }
  });

  // ─── /help ────────────────────────────────────────────────────────────────
  bot.command('help', async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    if (isGroupChat(ctx)) {
      autoRegisterGroupAndUser(ctx, user.id, user.username, user.first_name);
    } else {
      upsertUser(user.id, user.username, user.first_name);
      if (!isAdmin(user.id) && !checkGroupMembership(user.id)) {
        return sendPrivate(ctx, user.id, '🚫 Access Denied. Join a competition group first.');
      }
    }

    const name = escapeHtml(user.first_name);
    const msg = isAdmin(user.id) ? ADMIN_HELP(name) : USER_HELP(name);
    await sendPrivate(ctx, user.id, msg, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });

  // ─── /matches — show list with Predict buttons ───────────────────────────
  bot.command('matches', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    upsertUser(user.id, user.username, user.first_name);

    if (isGroupChat(ctx)) {
      autoRegisterGroupAndUser(ctx, user.id, user.username, user.first_name);
      await showMatchesForGroup(ctx, user.id, getChatGroupId(ctx));
    } else {
      const groupId = await resolveGroupForDM(ctx, user.id, 'matches');
      if (groupId !== null) await showMatchesForGroup(ctx, user.id, groupId);
    }
  });

  // ─── /missing — active matches user hasn't predicted ────────────────────
  bot.command('missing', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    upsertUser(user.id, user.username, user.first_name);

    if (isGroupChat(ctx)) {
      autoRegisterGroupAndUser(ctx, user.id, user.username, user.first_name);
      await showMissingForGroup(ctx, user.id, getChatGroupId(ctx));
    } else {
      const groupId = await resolveGroupForDM(ctx, user.id, 'missing');
      if (groupId !== null) await showMissingForGroup(ctx, user.id, groupId);
    }
  });

  // ─── /mypicks — all predictions across all groups ────────────────────────
  bot.command('mypicks', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    upsertUser(user.id, user.username, user.first_name);
    if (isGroupChat(ctx)) {
      autoRegisterGroupAndUser(ctx, user.id, user.username, user.first_name);
    }
    await showAllPicks(ctx, user.id);
  });

  // ─── /leaderboard ────────────────────────────────────────────────────────
  bot.command('leaderboard', async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    if (isGroupChat(ctx)) {
      autoRegisterGroupAndUser(ctx, user.id, user.username, user.first_name);
      const groupId = getChatGroupId(ctx);
      const groupName = getChatGroupName(ctx);
      const board = getGroupLeaderboard(groupId);
      await sendLeaderboardMessage(ctx, board, `${escapeHtml(groupName)} Leaderboard`);
    } else {
      // In DM: show global leaderboard
      const board = getGlobalLeaderboard(20);
      await sendLeaderboardMessage(ctx, board, 'Global Leaderboard');

      // Also offer group-specific leaderboards if user is in multiple groups
      const groups = getUserGroups(user.id);
      if (groups.length > 1) {
        const buttons = groups.map((g: any) => [
          Markup.button.callback(
            `🏆 ${escapeHtml(g.group_name || `Group ${g.group_id}`)}`,
            `gsel_${g.group_id}_leaderboard`
          ),
        ]);
        await ctx.reply('📊 View group-specific leaderboard:', Markup.inlineKeyboard(buttons));
      } else if (groups.length === 1) {
        const board = getGroupLeaderboard(groups[0].group_id);
        const gname = groups[0].group_name || `Group ${groups[0].group_id}`;
        await sendLeaderboardMessage(ctx, board, `${escapeHtml(gname)} Leaderboard`);
      }
    }
  });

  // ─── /mystats — shows stats in current chat ──────────────────────────────
  bot.command('mystats', async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    const dbUser = getUser(user.id);
    if (!dbUser) return ctx.reply('You haven\'t played yet. Use /start in a group to register!');

    const groups = getUserGroups(user.id);
    const predictions = getAllUserPredictionsWithGroups(user.id);
    const name = escapeHtml(displayName({ username: user.username, first_name: user.first_name, telegram_id: user.id }));

    let text = `📊 <b>Stats for ${name}</b>\n\n`;
    text += `🌍 Total Points (Global): <b>${dbUser.total_points}</b>\n`;

    if (groups.length > 0) {
      text += `\n<b>Points by Competition:</b>\n`;
      for (const g of groups) {
        text += `• ${escapeHtml(g.group_name || `Group ${g.group_id}`)}: <b>${g.total_points} pts</b>\n`;
      }
    }

    text += `\n<b>Recent Predictions:</b>\n`;
    if (predictions.length === 0) {
      text += '<i>No predictions yet. Use /matches to get started!</i>';
    } else {
      for (const p of predictions) {
        const groupLabel = escapeHtml(p.group_name || (p.group_id ? `Group ${p.group_id}` : 'No group'));
        if (p.status === 'finished') {
          const pts = p.points_awarded !== null ? p.points_awarded : '?';
          const label = p.points_awarded !== null ? pointsLabel(p.points_awarded) : '';
          text += `\n• <b>${escapeHtml(p.home_team)} ${p.actual_home_score}–${p.actual_away_score} ${escapeHtml(p.away_team)}</b>\n`;
          text += `  🏆 ${groupLabel} | Pick: <b>${p.predicted_home_score}-${p.predicted_away_score}</b> | <b>${pts} pts</b>${label ? ` ${label}` : ''}\n`;
        } else {
          text += `\n• <b>${escapeHtml(p.home_team)} vs ${escapeHtml(p.away_team)}</b>\n`;
          text += `  🏆 ${groupLabel} | Pick: <b>${p.predicted_home_score}-${p.predicted_away_score}</b> | <i>Pending…</i>\n`;
        }
      }
    }
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // ─── Callback: group selection (gsel_<groupId>_<action>) ─────────────────
  // groupId can be negative (Telegram supergroup IDs are negative)
  bot.action(/^gsel_(-?\d+)_(\w+)$/, async (ctx) => {
    const user = ctx.from;
    if (!user) return ctx.answerCbQuery();
    await ctx.answerCbQuery();

    const groupId = parseInt(ctx.match[1], 10);
    const action = ctx.match[2];

    if (action === 'matches') {
      await showMatchesForGroup(ctx, user.id, groupId);
    } else if (action === 'missing') {
      await showMissingForGroup(ctx, user.id, groupId);
    } else if (action === 'mypicks') {
      await showPicksForGroup(ctx, user.id, groupId);
    } else if (action === 'leaderboard') {
      const board = getGroupLeaderboard(groupId);
      await sendLeaderboardMessage(ctx, board, `Group Leaderboard`);
    }
  });

  // ─── Callback: user clicks "Predict" button ───────────────────────────────
  // Format: predict_{matchId}_{groupId}  (groupId can be negative)
  bot.action(/^predict_(\d+)_(-?\d+)$/, async (ctx) => {
    const user = ctx.from;
    if (!user) return ctx.answerCbQuery();

    const matchId = parseInt(ctx.match[1], 10);
    const groupId = parseInt(ctx.match[2], 10);
    const match = getMatch(matchId);

    if (!match) return ctx.answerCbQuery('❌ Match not found');
    if (match.status !== 'active') return ctx.answerCbQuery('❌ Match is not open for predictions');
    if (isMatchLocked(match.kickoff_time)) return ctx.answerCbQuery('🔒 Predictions are locked for this match');

    pendingPrediction.set(user.id, { matchId, groupId });
    await ctx.answerCbQuery();

    await sendPrivate(ctx, user.id,
      `🎯 <b>Predict: ${escapeHtml(match.home_team)} vs ${escapeHtml(match.away_team)}</b>\n` +
      `📅 ${formatKickoff(match.kickoff_time)}\n\n` +
      `Type your predicted score:\n` +
      `<code>home-away</code>  (e.g. <code>2-1</code> or <code>0-0</code>)\n\n` +
      `<i>Type /cancel to cancel</i>`,
      { parse_mode: 'HTML' }
    );
  });

  // ─── /lastresults — predictions from all users for last-24h finished matches
  bot.command('lastresults', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    upsertUser(user.id, user.username, user.first_name);
    if (isGroupChat(ctx)) autoRegisterGroupAndUser(ctx, user.id, user.username, user.first_name);

    const rows = getLastResultsPredictions(24);

    if (rows.length === 0) {
      await ctx.reply('📭 No finished matches in the last 24 hours.');
      return;
    }

    // Group rows: matchId → groupId → predictions[]
    const matchMap = new Map<number, {
      home_team: string; away_team: string; league: string;
      kickoff_time: string; actual_home_score: number; actual_away_score: number;
      groups: Map<string, { groupId: number; groupName: string; preds: any[] }>;
    }>();

    for (const row of rows) {
      if (!matchMap.has(row.match_id)) {
        matchMap.set(row.match_id, {
          home_team: row.home_team, away_team: row.away_team, league: row.league,
          kickoff_time: row.kickoff_time,
          actual_home_score: row.actual_home_score, actual_away_score: row.actual_away_score,
          groups: new Map(),
        });
      }
      const matchData = matchMap.get(row.match_id)!;
      const groupKey = String(row.group_id ?? 0);
      if (!matchData.groups.has(groupKey)) {
        matchData.groups.set(groupKey, {
          groupId: row.group_id ?? 0,
          groupName: row.group_name || (row.group_id ? `Group ${row.group_id}` : 'No group'),
          preds: [],
        });
      }
      matchData.groups.get(groupKey)!.preds.push(row);
    }

    let text = `📊 <b>Last 24h Results</b>\n\n`;

    for (const [, m] of matchMap) {
      text += `⚽ <b>${escapeHtml(m.home_team)} ${m.actual_home_score}–${m.actual_away_score} ${escapeHtml(m.away_team)}</b>\n`;
      text += `🏆 ${escapeHtml(m.league)} | ${formatKickoff(m.kickoff_time)}\n`;

      for (const [, g] of m.groups) {
        text += `\n   <b>${escapeHtml(g.groupName)}:</b>\n`;
        for (const p of g.preds) {
          const name = escapeHtml(p.username || p.first_name || `User${p.user_telegram_id}`);
          const pts = p.points_awarded !== null
            ? `<b>${p.points_awarded} pts</b> — ${pointsLabel(p.points_awarded)}`
            : '<i>not scored</i>';
          text += `   • ${name}: <b>${p.predicted_home_score}-${p.predicted_away_score}</b> | ${pts}\n`;
        }
      }
      text += '\n';
    }

    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // ─── /cancel — cancel pending prediction ─────────────────────────────────
  bot.command('cancel', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    if (pendingPrediction.has(user.id)) {
      pendingPrediction.delete(user.id);
      await sendPrivate(ctx, user.id, '❌ Prediction cancelled.');
    } else {
      await sendPrivate(ctx, user.id, 'Nothing to cancel.');
    }
  });

  // ─── /predict command (power users / backward compat) ────────────────────
  bot.command('predict', async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    if (!isAdmin(user.id) && !checkGroupMembership(user.id)) {
      return sendPrivate(ctx, user.id, '🚫 Access Denied.');
    }
    upsertUser(user.id, user.username, user.first_name);

    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
      return sendPrivate(ctx, user.id,
        'Use /matches to predict via buttons, or:\n<code>/predict &lt;match_id&gt; &lt;home&gt;-&lt;away&gt;</code>',
        { parse_mode: 'HTML' }
      );
    }

    const matchId = parseInt(args[0], 10);
    const scoreParts = args[1].split('-');
    if (isNaN(matchId) || scoreParts.length !== 2) {
      return sendPrivate(ctx, user.id, '❌ Invalid format. Example: <code>/predict 12345 2-1</code>', { parse_mode: 'HTML' });
    }

    const homeScore = parseInt(scoreParts[0], 10);
    const awayScore = parseInt(scoreParts[1], 10);
    if (isNaN(homeScore) || isNaN(awayScore) || homeScore < 0 || awayScore < 0) {
      return sendPrivate(ctx, user.id, '❌ Scores must be non-negative numbers.');
    }

    const match = getMatch(matchId);
    if (!match) return sendPrivate(ctx, user.id, `❌ Match #${matchId} not found.`);
    if (match.status !== 'active') return sendPrivate(ctx, user.id, `❌ Match #${matchId} is not open for predictions.`);
    if (isMatchLocked(match.kickoff_time)) return sendPrivate(ctx, user.id, `🔒 Predictions for this match are locked.`);

    // Determine groupId: use current group if in a group chat, else first joined group
    let groupId = 0;
    if (isGroupChat(ctx)) {
      groupId = getChatGroupId(ctx);
    } else {
      const groups = getUserGroups(user.id);
      if (groups.length === 1) {
        groupId = groups[0].group_id;
      } else if (groups.length > 1) {
        // Can't tell which group — direct the user to the button flow
        return sendPrivate(ctx, user.id,
          `⚠️ You are in multiple groups. Please use /matches to predict via buttons so your pick is counted on the right leaderboard.`,
        );
      }
      // groups.length === 0 → not in any group; upsertPrediction will save with group_id=0
    }

    upsertPrediction(user.id, matchId, groupId, homeScore, awayScore);
    await sendPrivate(ctx, user.id,
      `✅ <b>Prediction saved!</b>\n\n` +
      `⚽ <b>${escapeHtml(match.home_team)} vs ${escapeHtml(match.away_team)}</b>\n` +
      `📅 ${formatKickoff(match.kickoff_time)}\n` +
      `🎯 Your prediction: <b>${homeScore} - ${awayScore}</b>`,
      { parse_mode: 'HTML' }
    );
  });

  // ─── Message handler: capture score input after button flow ───────────────
  // IMPORTANT: This catch-all MUST be registered LAST because bot.on('text')
  // matches ALL text messages including commands. If registered before a
  // bot.command() handler, the return without next() kills the middleware
  // chain and prevents subsequent command handlers from ever executing.
  bot.on('text', async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    // Only intercept if user has a pending prediction
    if (!pendingPrediction.has(user.id)) return;

    const text = ctx.message.text.trim();

    // Let commands pass through
    if (text.startsWith('/')) return;

    const pending = pendingPrediction.get(user.id)!;
    const { matchId, groupId } = pending;
    const match = getMatch(matchId);

    if (!match) {
      pendingPrediction.delete(user.id);
      return sendPrivate(ctx, user.id, '❌ Match no longer available.');
    }

    // Re-check lock in case time passed
    if (isMatchLocked(match.kickoff_time)) {
      pendingPrediction.delete(user.id);
      return sendPrivate(ctx, user.id, '🔒 Sorry, predictions for this match are now locked.');
    }

    // Parse the score input
    const scoreParts = text.split('-');
    if (scoreParts.length !== 2) {
      return sendPrivate(ctx, user.id,
        '❌ Invalid format. Please type the score like: <code>2-1</code>',
        { parse_mode: 'HTML' }
      );
    }

    const homeScore = parseInt(scoreParts[0].trim(), 10);
    const awayScore = parseInt(scoreParts[1].trim(), 10);

    if (isNaN(homeScore) || isNaN(awayScore) || homeScore < 0 || awayScore < 0) {
      return sendPrivate(ctx, user.id,
        '❌ Invalid score. Use numbers like <code>2-1</code> or <code>0-0</code>',
        { parse_mode: 'HTML' }
      );
    }

    // Save prediction
    upsertUser(user.id, user.username, user.first_name);
    const saved = upsertPrediction(user.id, matchId, groupId, homeScore, awayScore);
    pendingPrediction.delete(user.id);

    if (!saved) {
      return sendPrivate(ctx, user.id, '⚠️ This match has already been finalized. Prediction not saved.');
    }

    await sendPrivate(ctx, user.id,
      `✅ <b>Prediction saved!</b>\n\n` +
      `⚽ <b>${escapeHtml(match.home_team)} vs ${escapeHtml(match.away_team)}</b>\n` +
      `📅 ${formatKickoff(match.kickoff_time)}\n` +
      `🎯 Your prediction: <b>${homeScore} - ${awayScore}</b>\n\n` +
      `You can update anytime before lockout via /matches`,
      { parse_mode: 'HTML' }
    );
  });
}
