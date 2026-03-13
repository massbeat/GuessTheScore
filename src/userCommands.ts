import { Telegraf, Markup } from 'telegraf';
import {
  upsertUser,
  getActiveMatches,
  getMatch,
  upsertPrediction,
  getUserPredictions,
  getLeaderboard,
  getUser,
  getUnpredictedMatches,
  getPredictedMatches,
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

// In-memory state for the predict conversation flow
// Maps telegramId -> matchId they are currently predicting for
const pendingPrediction: Map<number, number> = new Map();

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
  `🏆 /leaderboard — Top 20 players\n` +
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
  `🏆 /leaderboard — Top 20 players\n` +
  `❓ /help — Show this help\n\n` +
  `<b>👑 Admin Commands:</b>\n\n` +
  `<b>📥 Fetching matches:</b>\n` +
  `• /admin_competitions — Browse all competitions (buttons)\n` +
  `• /admin_fetch &lt;code&gt; [matchday] — Fetch by code\n` +
  `  e.g. <code>/admin_fetch PL</code> or <code>/admin_fetch PL 28</code>\n\n` +
  `<b>🗂 Managing active matches:</b>\n` +
  `• /admin_active — List currently active matches\n\n` +
  `<b>✅ Finalizing results:</b>\n` +
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

  // ─── /start ───────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    const isMember = await checkGroupMembership(ctx, user.id);
    if (!isMember) return sendPrivate(ctx, user.id, '🚫 Access Denied. You must be a member of the competition group to use this bot.');
    upsertUser(user.id, user.username, user.first_name);
    const name = escapeHtml(user.first_name);
    const msg = isAdmin(user.id) ? ADMIN_HELP(name) : USER_HELP(name);
    await sendPrivate(ctx, user.id, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
  });

  // ─── /help ────────────────────────────────────────────────────────────────
  bot.command('help', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    const isMember = await checkGroupMembership(ctx, user.id);
    if (!isMember) return sendPrivate(ctx, user.id, '🚫 Access Denied.');
    upsertUser(user.id, user.username, user.first_name);
    const name = escapeHtml(user.first_name);
    const msg = isAdmin(user.id) ? ADMIN_HELP(name) : USER_HELP(name);
    await sendPrivate(ctx, user.id, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
  });

  // ─── /matches — show list with Predict buttons ───────────────────────────
  bot.command('matches', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    const isMember = await checkGroupMembership(ctx, user.id);
    if (!isMember) return sendPrivate(ctx, user.id, '🚫 Access Denied.');

    const matches = getActiveMatches();
    if (matches.length === 0) return sendPrivate(ctx, user.id, '📭 No matches are currently open for prediction.');

    await sendPrivate(ctx, user.id, `⚽ <b>Open Matches</b>\nClick a match to submit your prediction:`, { parse_mode: 'HTML' });

    for (const m of matches) {
      const locked = isMatchLocked(m.kickoff_time);
      const matchInfo =
        `${locked ? '🔒' : '🟢'} <b>${escapeHtml(m.home_team)} vs ${escapeHtml(m.away_team)}</b>\n` +
        `📅 ${formatKickoff(m.kickoff_time)}\n` +
        `🏆 ${escapeHtml(m.league)}`;

      if (locked) {
        await sendPrivate(ctx, user.id, matchInfo + '\n<i>Predictions locked</i>', { parse_mode: 'HTML' });
      } else {
        await sendPrivate(ctx, user.id, matchInfo, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`🎯 Predict this match`, `predict_${m.id}`)],
          ]),
        });
      }
    }
  });

  // ─── Callback: user clicks "Predict this match" button ───────────────────
  bot.action(/^predict_(\d+)$/, async (ctx) => {
    const user = ctx.from;
    if (!user) return ctx.answerCbQuery();

    const matchId = parseInt(ctx.match[1], 10);
    const match = getMatch(matchId);

    if (!match) return ctx.answerCbQuery('❌ Match not found');
    if (match.status !== 'active') return ctx.answerCbQuery('❌ Match is not open for predictions');
    if (isMatchLocked(match.kickoff_time)) return ctx.answerCbQuery('🔒 Predictions are locked for this match');

    // Store which match this user is predicting for
    pendingPrediction.set(user.id, matchId);

    await ctx.answerCbQuery();
    await sendPrivate(ctx, user.id,
      `🎯 <b>Predict: ${escapeHtml(match.home_team)} vs ${escapeHtml(match.away_team)}</b>\n` +
      `📅 ${formatKickoff(match.kickoff_time)}\n\n` +
      `Type your predicted score in the format:\n` +
      `<code>home-away</code>  (e.g. <code>2-1</code> or <code>0-0</code>)\n\n` +
      `<i>Type /cancel to cancel</i>`,
      { parse_mode: 'HTML' }
    );
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

  // ─── /predict command (kept for power users / backwards compat) ───────────
  bot.command('predict', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    const isMember = await checkGroupMembership(ctx, user.id);
    if (!isMember) return sendPrivate(ctx, user.id, '🚫 Access Denied.');
    upsertUser(user.id, user.username, user.first_name);

    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
      const matches = getActiveMatches();
      if (matches.length === 0) return sendPrivate(ctx, user.id, '📭 No matches are currently open for prediction.');
      await sendPrivate(ctx, user.id, 'Use /matches to see open fixtures and predict via buttons, or use:\n<code>/predict &lt;match_id&gt; &lt;home&gt;-&lt;away&gt;</code>', { parse_mode: 'HTML' });
      return;
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

    upsertPrediction(user.id, matchId, homeScore, awayScore);
    await sendPrivate(ctx, user.id,
      `✅ <b>Prediction saved!</b>\n\n` +
      `⚽ <b>${escapeHtml(match.home_team)} vs ${escapeHtml(match.away_team)}</b>\n` +
      `📅 ${formatKickoff(match.kickoff_time)}\n` +
      `🎯 Your prediction: <b>${homeScore} - ${awayScore}</b>`,
      { parse_mode: 'HTML' }
    );
  });

  // ─── /missing — show active matches user hasn't predicted ────────────────
  bot.command('missing', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    const isMember = await checkGroupMembership(ctx, user.id);
    if (!isMember) return sendPrivate(ctx, user.id, '🚫 Access Denied.');
    upsertUser(user.id, user.username, user.first_name);

    const matches = getUnpredictedMatches(user.id);
    if (matches.length === 0) return sendPrivate(ctx, user.id, '✅ You\'re all caught up! You\'ve predicted every active match.');

    await sendPrivate(ctx, user.id, `📋 <b>Matches Without Your Prediction (${matches.length})</b>\nClick a match to submit your prediction:`, { parse_mode: 'HTML' });

    for (const m of matches) {
      const locked = isMatchLocked(m.kickoff_time);
      const matchInfo =
        `${locked ? '🔒' : '🟢'} <b>${escapeHtml(m.home_team)} vs ${escapeHtml(m.away_team)}</b>\n` +
        `📅 ${formatKickoff(m.kickoff_time)}\n` +
        `🏆 ${escapeHtml(m.league)}`;

      if (locked) {
        await sendPrivate(ctx, user.id, matchInfo + '\n<i>Predictions locked</i>', { parse_mode: 'HTML' });
      } else {
        await sendPrivate(ctx, user.id, matchInfo, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`🎯 Predict this match`, `predict_${m.id}`)],
          ]),
        });
      }
    }
  });

  // ─── /mypicks — show active matches user already predicted ──────────────
  bot.command('mypicks', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    const isMember = await checkGroupMembership(ctx, user.id);
    if (!isMember) return sendPrivate(ctx, user.id, '🚫 Access Denied.');
    upsertUser(user.id, user.username, user.first_name);

    const matches = getPredictedMatches(user.id);
    if (matches.length === 0) return sendPrivate(ctx, user.id, '📭 You haven\'t predicted any active matches yet. Use /matches to get started!');

    let text = `✅ <b>Your Predictions (${matches.length} active matches)</b>\n`;
    for (const m of matches) {
      const locked = isMatchLocked(m.kickoff_time);
      text += `\n${locked ? '🔒' : '🟢'} <b>${escapeHtml(m.home_team)} vs ${escapeHtml(m.away_team)}</b>\n`;
      text += `   📅 ${formatKickoff(m.kickoff_time)}\n`;
      text += `   🎯 Your pick: <b>${m.predicted_home_score} - ${m.predicted_away_score}</b>`;
      text += locked ? '' : '  <i>(editable)</i>';
      text += '\n';
    }
    await sendPrivate(ctx, user.id, text, { parse_mode: 'HTML' });
  });

  // ─── /mystats — replies in group so others can see ──────────────────────
  bot.command('mystats', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    const isMember = await checkGroupMembership(ctx, user.id);
    if (!isMember) return ctx.reply('🚫 Access Denied.');

    const dbUser = getUser(user.id);
    if (!dbUser) return ctx.reply('You haven\'t played yet. Use /start to register!');

    const predictions = getUserPredictions(user.id);
    const name = escapeHtml(displayName({ username: user.username, first_name: user.first_name, telegram_id: user.id }));
    let text = `📊 <b>Stats for ${name}</b>\n\n🏆 Total Points: <b>${dbUser.total_points}</b>\n\n<b>Recent Predictions:</b>\n`;

    if (predictions.length === 0) {
      text += '<i>No predictions yet. Use /matches to get started!</i>';
    } else {
      for (const p of predictions) {
        const status = p.status === 'finished'
          ? `${p.actual_home_score}-${p.actual_away_score} | <b>${p.points_awarded ?? '?'} pts</b>`
          : '<i>Pending...</i>';
        text += `\n• <b>${escapeHtml(p.home_team)} vs ${escapeHtml(p.away_team)}</b>\n`;
        text += `  Pick: <b>${p.predicted_home_score}-${p.predicted_away_score}</b> | Result: ${status}\n`;
      }
    }
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // ─── /leaderboard — replies in group so others can see ─────────────────
  bot.command('leaderboard', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    const isMember = await checkGroupMembership(ctx, user.id);
    if (!isMember) return ctx.reply('🚫 Access Denied.');

    const board = getLeaderboard(20);
    if (board.length === 0) return ctx.reply('🏆 No scores yet. Be the first to predict!');

    const medals = ['🥇', '🥈', '🥉'];
    let text = `🏆 <b>Leaderboard (Top ${board.length})</b>\n\n`;
    board.forEach((u: any, i: number) => {
      const medal = medals[i] ?? `${i + 1}.`;
      text += `${medal} ${escapeHtml(displayName(u))} — <b>${u.total_points} pts</b>\n`;
    });
    await ctx.reply(text, { parse_mode: 'HTML' });
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

    const matchId = pendingPrediction.get(user.id)!;
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
    upsertPrediction(user.id, matchId, homeScore, awayScore);
    pendingPrediction.delete(user.id);

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
