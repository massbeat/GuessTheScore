import { Telegraf, Markup } from 'telegraf';
import {
  upsertMatch,
  activateMatch,
  deactivateMatch,
  getMatch,
  getActiveMatches,
  setMatchResult,
  getPredictionsForMatch,
  awardPoints,
  clearAllScoresAndPredictions,
  deactivateAllMatches,
  getFinishedMatches,
  resetFinishedMatches,
} from './database';
import { fetchCompetitions, fetchFixturesByCompetition, fetchMatchById } from './footballApi';
import { isAdmin, formatKickoff, escapeHtml } from './helpers';
import { calculatePoints, pointsLabel } from './scoring';

// Maps messageId -> array of matchIds shown in that message's keyboard
// This lets the toggle callback redraw ALL buttons in a message, not just the one tapped
const messageMatchIds: Map<number, number[]> = new Map();

// Build the inline keyboard for a group of matches, reflecting current active state
function buildMatchKeyboard(matchIds: number[]) {
  const activeIds = new Set(getActiveMatches().map((m: any) => m.id));
  const buttons = matchIds.map(id => {
    const m = getMatch(id);
    if (!m) return null;
    const label = `${activeIds.has(id) ? '✅' : '⬜'} ${m.home_team} vs ${m.away_team}`;
    return [Markup.button.callback(label, `toggle_${id}`)];
  }).filter(Boolean) as ReturnType<typeof Markup.button.callback>[][];
  return Markup.inlineKeyboard(buttons);
}

// Send one matchday block and store which matchIds belong to that message
async function sendMatchdayBlock(ctx: any, dayLabel: string, matches: any[]) {
  const lines = matches.map(f =>
    `<b>${escapeHtml(f.home_team)} vs ${escapeHtml(f.away_team)}</b>  [${f.id}]\n` +
    `📅 ${formatKickoff(f.kickoff_time)}`
  ).join('\n\n');

  const matchIds = matches.map(f => f.id);
  const keyboard = buildMatchKeyboard(matchIds);

  const sent = await ctx.reply(
    `📅 <b>${dayLabel}</b>\n\n${lines}`,
    { parse_mode: 'HTML', ...keyboard }
  );

  // Store the message_id → match IDs mapping for later toggle updates
  if (sent?.message_id) {
    messageMatchIds.set(sent.message_id, matchIds);
  }
}

export function registerAdminCommands(bot: Telegraf): void {

  const adminOnly = async (ctx: any, next: () => Promise<void>) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      await ctx.reply('🚫 Admin access required.');
      return;
    }
    return next();
  };

  // ─── /admin_competitions ───────────────────────────────────────────────────
  bot.command('admin_competitions', adminOnly, async (ctx) => {
    await ctx.reply('⏳ Loading available competitions...');

    try {
      const competitions = await fetchCompetitions();
      console.log(`Fetched ${competitions.length} competitions`);

      if (competitions.length === 0) {
        return ctx.reply('📭 No competitions available. Check your FOOTBALL_DATA_API_KEY.');
      }

      const accessible = competitions.filter(c => c.plan === 'TIER_ONE' || c.plan === 'TIER_TWO');
      const lockedTier = competitions.filter(c => c.plan !== 'TIER_ONE' && c.plan !== 'TIER_TWO');

      await ctx.reply(
        `🏆 <b>Available Competitions</b>\n\n` +
        `✅ Free tier: <b>${accessible.length}</b> competitions\n` +
        `🔒 Paid tier: <b>${lockedTier.length}</b> competitions\n\n` +
        `Tap a competition to load its upcoming matches:`,
        { parse_mode: 'HTML' }
      );

      const BATCH = 6;
      for (let i = 0; i < accessible.length; i += BATCH) {
        const batch = accessible.slice(i, i + BATCH);
        const buttons = batch.map(c =>
          [Markup.button.callback(`🏆 ${c.name} (${c.area})`, `comp_${c.code}`)]
        );
        await ctx.reply(
          batch.map(c => `<code>${c.code}</code> — ${escapeHtml(c.name)} · ${escapeHtml(c.area)}`).join('\n'),
          { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
        );
      }

    } catch (err: any) {
      console.error('admin_competitions error:', err.message, err.response?.data);
      await ctx.reply(
        `❌ Failed to load competitions.\n\nError: <code>${escapeHtml(err.message)}</code>\n\n` +
        `Make sure <b>FOOTBALL_DATA_API_KEY</b> is set in your .env file.\n` +
        `Get a free key at: https://www.football-data.org/client/register`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // ─── Callback: competition button tapped ──────────────────────────────────
  bot.action(/^comp_(.+)$/, adminOnly, async (ctx) => {
    const code = ctx.match[1];
    await ctx.answerCbQuery(`⏳ Loading ${code}...`);
    await ctx.reply(`⏳ Fetching upcoming matches for <b>${escapeHtml(code)}</b>...`, { parse_mode: 'HTML' });

    try {
      const fixtures = await fetchFixturesByCompetition(code);
      console.log(`Fetched ${fixtures.length} fixtures for ${code}`);

      if (fixtures.length === 0) {
        return ctx.reply(
          `📭 No scheduled matches found for <b>${escapeHtml(code)}</b>.\n\n` +
          `Try a specific matchday: <code>/admin_fetch ${code} 28</code>`,
          { parse_mode: 'HTML' }
        );
      }

      fixtures.forEach(f => upsertMatch(f));

      // Group by matchday
      const byMatchday = new Map<string, typeof fixtures>();
      for (const f of fixtures) {
        const key = f.matchday ? `Matchday ${f.matchday}` : 'Upcoming';
        if (!byMatchday.has(key)) byMatchday.set(key, []);
        byMatchday.get(key)!.push(f);
      }

      await ctx.reply(
        `📋 <b>${escapeHtml(code)}</b> — <b>${fixtures.length} upcoming matches</b>\n` +
        `Toggle ✅/⬜ to add or remove matches from the competition:`,
        { parse_mode: 'HTML' }
      );

      for (const [dayLabel, matches] of byMatchday) {
        await sendMatchdayBlock(ctx, dayLabel, matches);
      }

    } catch (err: any) {
      console.error('comp callback error:', err.message, err.response?.data);
      await ctx.reply(`❌ Error: <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
    }
  });

  // ─── /admin_fetch <code> [matchday] ───────────────────────────────────────
  bot.command('admin_fetch', adminOnly, async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const code = args[0]?.toUpperCase();
    const matchday = args[1] ? parseInt(args[1], 10) : undefined;

    if (!code) {
      return ctx.reply(
        '❌ Usage: <code>/admin_fetch &lt;code&gt; [matchday]</code>\n\n' +
        'Examples:\n' +
        '<code>/admin_fetch PL</code>  — Premier League upcoming\n' +
        '<code>/admin_fetch PL 28</code>  — Matchday 28\n' +
        '<code>/admin_fetch CL</code>  — Champions League\n\n' +
        'Or use /admin_competitions to browse all.',
        { parse_mode: 'HTML' }
      );
    }

    await ctx.reply(
      `⏳ Fetching <b>${escapeHtml(code)}</b>${matchday ? ` matchday ${matchday}` : ' upcoming'}...`,
      { parse_mode: 'HTML' }
    );

    try {
      const fixtures = await fetchFixturesByCompetition(code, matchday);
      console.log(`Fetched ${fixtures.length} fixtures for ${code} MD${matchday ?? 'upcoming'}`);

      if (fixtures.length === 0) {
        return ctx.reply(
          `📭 No scheduled matches found for <b>${escapeHtml(code)}</b>${matchday ? ` matchday ${matchday}` : ''}.`,
          { parse_mode: 'HTML' }
        );
      }

      fixtures.forEach(f => upsertMatch(f));

      // Group by matchday
      const byMatchday = new Map<string, typeof fixtures>();
      for (const f of fixtures) {
        const key = f.matchday ? `Matchday ${f.matchday}` : 'Upcoming';
        if (!byMatchday.has(key)) byMatchday.set(key, []);
        byMatchday.get(key)!.push(f);
      }

      await ctx.reply(
        `📋 Found <b>${fixtures.length} matches</b> for ${escapeHtml(code)}${matchday ? ` MD${matchday}` : ''}.\n` +
        `Toggle ✅/⬜ to add or remove matches:`,
        { parse_mode: 'HTML' }
      );

      for (const [dayLabel, matches] of byMatchday) {
        await sendMatchdayBlock(ctx, dayLabel, matches);
      }

    } catch (err: any) {
      console.error('admin_fetch error:', err.message, err.response?.data);
      await ctx.reply(
        `❌ Error: <code>${escapeHtml(err.message)}</code>\n\nCheck your FOOTBALL_DATA_API_KEY is valid.`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // ─── Callback: toggle a single match on/off ───────────────────────────────
  bot.action(/^toggle_(\d+)$/, adminOnly, async (ctx) => {
    const matchId = parseInt(ctx.match[1], 10);
    const match = getMatch(matchId);
    if (!match) return ctx.answerCbQuery('❌ Match not found');
    if (match.status === 'finished') return ctx.answerCbQuery('⚠️ Match already finished');

    // Toggle
    const nowActive = match.status !== 'active';
    if (nowActive) {
      activateMatch(matchId);
      await ctx.answerCbQuery(`✅ Added: ${match.home_team} vs ${match.away_team}`);
    } else {
      deactivateMatch(matchId);
      await ctx.answerCbQuery(`⬜ Removed: ${match.home_team} vs ${match.away_team}`);
    }

    // Rebuild the FULL keyboard for this message (all matches in this matchday block)
    try {
      const messageId = ctx.callbackQuery.message?.message_id;
      const matchIdsInMessage = messageId ? messageMatchIds.get(messageId) : null;

      if (matchIdsInMessage && matchIdsInMessage.length > 0) {
        // Redraw all buttons in this matchday block with updated states
        const keyboard = buildMatchKeyboard(matchIdsInMessage);
        await ctx.editMessageReplyMarkup(keyboard.reply_markup);
      } else {
        // Fallback: just update the single button if we lost track of the message
        const label = `${nowActive ? '✅' : '⬜'} ${match.home_team} vs ${match.away_team}`;
        await ctx.editMessageReplyMarkup({
          inline_keyboard: [[{ text: label, callback_data: `toggle_${matchId}` }]],
        });
      }
    } catch { /* message too old to edit */ }
  });

  // ─── /admin_active ────────────────────────────────────────────────────────
  bot.command('admin_active', adminOnly, async (ctx) => {
    const matches = getActiveMatches();
    if (matches.length === 0) return ctx.reply('📭 No active matches.');

    const lines = matches.map((m: any) =>
      `🟢 <b>${escapeHtml(m.home_team)} vs ${escapeHtml(m.away_team)}</b>  [${m.id}]\n` +
      `📅 ${formatKickoff(m.kickoff_time)}\n` +
      `🏆 ${escapeHtml(m.league)}`
    ).join('\n\n');

    await ctx.reply(`✅ <b>Active Matches (${matches.length}):</b>\n\n${lines}`, { parse_mode: 'HTML' });
  });

  // ─── /admin_update <match_id> ─────────────────────────────────────────────
  bot.command('admin_update', adminOnly, async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const matchId = parseInt(args[0], 10);
    if (isNaN(matchId)) {
      return ctx.reply('Usage: <code>/admin_update &lt;match_id&gt;</code>', { parse_mode: 'HTML' });
    }

    const match = getMatch(matchId);
    if (!match) return ctx.reply(`❌ Match #${matchId} not found.`);
    if (match.status === 'finished') return ctx.reply(`⚠️ Match #${matchId} is already finished.`);

    await ctx.reply(`⏳ Fetching result for match #${matchId}...`);

    try {
      const fixture = await fetchMatchById(matchId);
      if (!fixture) return ctx.reply(`❌ Match #${matchId} not found in API.`);

      if (fixture.status !== 'FINISHED' || fixture.home_score === null || fixture.away_score === null) {
        return ctx.reply(
          `⚠️ Match not finished yet (status: <b>${escapeHtml(fixture.status)}</b>).\n\n` +
          `Use <code>/admin_manual_score ${matchId} 2-1</code> to set manually.`,
          { parse_mode: 'HTML' }
        );
      }

      await finalizeMatch(ctx, matchId, fixture.home_score, fixture.away_score, match);

    } catch (err: any) {
      console.error('admin_update error:', err.message);
      await ctx.reply(
        `❌ API error: <code>${escapeHtml(err.message)}</code>\n` +
        `Use <code>/admin_manual_score ${matchId} 2-1</code> instead.`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // ─── /admin_manual_score <match_id> <home>-<away> ─────────────────────────
  bot.command('admin_manual_score', adminOnly, async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
      return ctx.reply(
        'Usage: <code>/admin_manual_score &lt;match_id&gt; &lt;home&gt;-&lt;away&gt;</code>\n' +
        'Example: <code>/admin_manual_score 12345 2-1</code>',
        { parse_mode: 'HTML' }
      );
    }

    const matchId = parseInt(args[0], 10);
    const scoreParts = args[1].split('-');
    if (isNaN(matchId) || scoreParts.length !== 2) {
      return ctx.reply('❌ Invalid format. Example: <code>/admin_manual_score 12345 2-1</code>', { parse_mode: 'HTML' });
    }

    const homeScore = parseInt(scoreParts[0], 10);
    const awayScore = parseInt(scoreParts[1], 10);
    if (isNaN(homeScore) || isNaN(awayScore) || homeScore < 0 || awayScore < 0) return ctx.reply('❌ Scores must be non-negative numbers.');

    const match = getMatch(matchId);
    if (!match) return ctx.reply(`❌ Match #${matchId} not found.`);
    if (match.status === 'finished') return ctx.reply(`⚠️ Match #${matchId} is already finished.`);

    await finalizeMatch(ctx, matchId, homeScore, awayScore, match);
  });

  // ─── /admin_clearleaderboard — reset all scores & predictions ────────────
  bot.command('admin_clearleaderboard', adminOnly, async (ctx) => {
    await ctx.reply(
      `⚠️ <b>Clear Leaderboard</b>\n\n` +
      `This will:\n` +
      `• Delete <b>ALL</b> predictions from all users\n` +
      `• Reset <b>ALL</b> user points to 0\n\n` +
      `<b>This action cannot be undone!</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Yes, clear everything', 'confirm_clearleaderboard'),
            Markup.button.callback('❌ Cancel', 'cancel_clearleaderboard'),
          ],
        ]),
      }
    );
  });

  bot.action('confirm_clearleaderboard', adminOnly, async (ctx) => {
    await ctx.answerCbQuery();
    const { usersReset, predictionsDeleted } = clearAllScoresAndPredictions();
    await ctx.editMessageText(
      `🗑 <b>Leaderboard Cleared!</b>\n\n` +
      `• ${predictionsDeleted} predictions deleted\n` +
      `• ${usersReset} users reset to 0 points`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action('cancel_clearleaderboard', adminOnly, async (ctx) => {
    await ctx.answerCbQuery('Cancelled');
    await ctx.editMessageText('❌ Clear leaderboard cancelled.');
  });

  // ─── /admin_clearmatchday — deactivate all active matches ────────────────
  bot.command('admin_clearmatchday', adminOnly, async (ctx) => {
    const activeMatches = getActiveMatches();
    if (activeMatches.length === 0) {
      return ctx.reply('📭 No active matches to clear.');
    }

    const matchList = activeMatches.map((m: any) =>
      `• ${escapeHtml(m.home_team)} vs ${escapeHtml(m.away_team)}`
    ).join('\n');

    await ctx.reply(
      `⚠️ <b>Clear Matchday</b>\n\n` +
      `This will deactivate <b>${activeMatches.length}</b> active matches:\n\n` +
      `${matchList}\n\n` +
      `No new predictions can be made until matches are activated again.\n` +
      `<b>Existing predictions will be kept.</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Yes, clear matchday', 'confirm_clearmatchday'),
            Markup.button.callback('❌ Cancel', 'cancel_clearmatchday'),
          ],
        ]),
      }
    );
  });

  bot.action('confirm_clearmatchday', adminOnly, async (ctx) => {
    await ctx.answerCbQuery();
    const count = deactivateAllMatches();
    await ctx.editMessageText(
      `🗑 <b>Matchday Cleared!</b>\n\n` +
      `${count} matches deactivated. No matches are open for predictions.\n` +
      `Use /admin_fetch or /admin_competitions to add new matches.`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action('cancel_clearmatchday', adminOnly, async (ctx) => {
    await ctx.answerCbQuery('Cancelled');
    await ctx.editMessageText('❌ Clear matchday cancelled.');
  });

  // ─── /admin_resetfinished — reset finished matches back to pending ───────
  bot.command('admin_resetfinished', adminOnly, async (ctx) => {
    const finished = getFinishedMatches();
    if (finished.length === 0) {
      return ctx.reply('📭 No finished matches to reset.');
    }

    const matchList = finished.map((m: any) =>
      `• ${escapeHtml(m.home_team)} <b>${m.actual_home_score}-${m.actual_away_score}</b> ${escapeHtml(m.away_team)}`
    ).join('\n');

    await ctx.reply(
      `⚠️ <b>Reset Finished Matches</b>\n\n` +
      `This will reset <b>${finished.length}</b> finished matches:\n\n` +
      `${matchList}\n\n` +
      `This will:\n` +
      `• Clear match results and set status back to pending\n` +
      `• Delete all predictions for these matches\n` +
      `• Deduct awarded points from users\n\n` +
      `Matches will be available for selection again.\n` +
      `<b>This action cannot be undone!</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Yes, reset all finished', 'confirm_resetfinished'),
            Markup.button.callback('❌ Cancel', 'cancel_resetfinished'),
          ],
        ]),
      }
    );
  });

  bot.action('confirm_resetfinished', adminOnly, async (ctx) => {
    await ctx.answerCbQuery();
    const { matchesReset, predictionsCleared, pointsDeducted } = resetFinishedMatches();
    await ctx.editMessageText(
      `🔄 <b>Finished Matches Reset!</b>\n\n` +
      `• ${matchesReset} matches reset to pending\n` +
      `• ${predictionsCleared} predictions removed\n` +
      `• ${pointsDeducted} points deducted from users\n\n` +
      `Use /admin_active or /admin_fetch to re-activate matches.`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action('cancel_resetfinished', adminOnly, async (ctx) => {
    await ctx.answerCbQuery('Cancelled');
    await ctx.editMessageText('❌ Reset finished matches cancelled.');
  });
}

// ─── Shared finalize logic ────────────────────────────────────────────────────
async function finalizeMatch(
  ctx: any,
  matchId: number,
  homeScore: number,
  awayScore: number,
  match: any
): Promise<void> {
  setMatchResult(matchId, homeScore, awayScore);
  const predictions = getPredictionsForMatch(matchId);

  let text =
    `✅ <b>Match Finalized!</b>\n\n` +
    `⚽ <b>${escapeHtml(match.home_team)} ${homeScore} - ${awayScore} ${escapeHtml(match.away_team)}</b>\n` +
    `🏆 ${escapeHtml(match.league)}\n\n` +
    `📊 <b>Results (${predictions.length} predictions):</b>`;

  if (predictions.length === 0) {
    text += '\n<i>No predictions were submitted.</i>';
  } else {
    for (const pred of predictions) {
      // Skip predictions that have already been scored (prevents double-scoring)
      if (pred.points_awarded !== null && pred.points_awarded !== undefined) {
        const name = pred.username ? `@${escapeHtml(pred.username)}` : escapeHtml(pred.first_name);
        text += `\n• ${name}: <b>${pred.predicted_home_score}-${pred.predicted_away_score}</b> → ${pointsLabel(pred.points_awarded)} (<b>${pred.points_awarded} pts</b>) <i>(already scored)</i>`;
        continue;
      }
      const points = calculatePoints(pred.predicted_home_score, pred.predicted_away_score, homeScore, awayScore);
      awardPoints(pred.id, points, pred.user_telegram_id);
      const name = pred.username ? `@${escapeHtml(pred.username)}` : escapeHtml(pred.first_name);
      text += `\n• ${name}: <b>${pred.predicted_home_score}-${pred.predicted_away_score}</b> → ${pointsLabel(points)} (<b>${points} pts</b>)`;
    }
  }

  await ctx.reply(text, { parse_mode: 'HTML' });
}
