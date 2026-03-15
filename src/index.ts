import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import { initDatabase, registerGroup, deactivateGroup } from './database';
import { registerUserCommands } from './userCommands';
import { registerAdminCommands } from './adminCommands';
import { TARGET_GROUP_IDS } from './helpers';

// ─── Startup logger ───────────────────────────────────────────────────────────
// Writes every step to logs/startup.log AND console so you can diagnose
// cPanel launch failures by checking the file even if stdout isn't captured.

// Derive absolute path to the project root from process.argv[1] (the bundle path).
// Under LiteSpeed FCGI, __dirname and cwd() point to the wrong directory, but
// argv[1] is always the absolute path to the running script (dist/bundle.js).
// We go up one level from dist/ to reach the project root.
const BUNDLE_PATH = path.resolve(process.argv[1]);
const PROJECT_ROOT = path.dirname(path.dirname(BUNDLE_PATH)); // dist/ -> project root
const LOG_DIR = process.env.LOG_DIR || path.join(PROJECT_ROOT, 'logs');
const STARTUP_LOG = path.join(LOG_DIR, 'startup.log');

function slog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(STARTUP_LOG, line + '\n', 'utf8');
  } catch { /* best-effort */ }
}

// Catch any completely unexpected crash and log it before dying
process.on('uncaughtException', (err) => {
  slog(`💥 UNCAUGHT EXCEPTION: ${err.message}`);
  slog(err.stack ?? '(no stack)');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  slog(`💥 UNHANDLED REJECTION: ${String(reason)}`);
  if (reason instanceof Error) slog(reason.stack ?? '(no stack)');
  process.exit(1);
});

// ─── Boot info ────────────────────────────────────────────────────────────────
slog('════════════════════════════════════════');
slog('Bot process starting...');
slog(`  Node version : ${process.version}`);
slog(`  PID          : ${process.pid}`);
slog(`  CWD          : ${process.cwd()}`);
slog(`  argv[1]      : ${process.argv[1]}`);
slog(`  __dirname    : ${__dirname}`);
slog(`  NODE_ENV     : ${process.env.NODE_ENV ?? '(not set)'}`);
slog(`  PORT         : ${process.env.PORT ?? '(not set)'}`);

// ─── Validate required env vars ───────────────────────────────────────────────
slog('Checking required environment variables...');
const requiredEnvVars = ['BOT_TOKEN', 'ADMIN_IDS', 'TARGET_GROUP_ID', 'FOOTBALL_DATA_API_KEY'];
let envOk = true;
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    slog(`  ❌ MISSING: ${key}`);
    envOk = false;
  } else {
    slog(`  ✅ ${key} = ${key === 'BOT_TOKEN' ? '***' : process.env[key]}`);
  }
}
if (!envOk) {
  slog('Aborting: missing required environment variables.');
  process.exit(1);
}
slog('Environment variables OK.');

// ─── HTTP server required by cPanel Passenger ─────────────────────────────────
// Passenger expects an HTTP server to start listening before it considers the
// app "up". Without this it kills the process after ~10 s.
slog('Starting HTTP server (required by cPanel Passenger)...');
const port = parseInt(process.env.PORT || '3000', 10);
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Football Prediction Bot is running\n');
});

httpServer.on('error', (err) => {
  slog(`❌ HTTP server error: ${err.message}`);
});

httpServer.listen(port, () => {
  slog(`✅ HTTP server listening on port ${port}`);
});

// ─── Main async startup ───────────────────────────────────────────────────────
async function main() {
  slog('Initializing database...');
  try {
    await initDatabase();
    slog('✅ Database initialized.');
  } catch (err: any) {
    slog(`❌ Database init failed: ${err.message}`);
    slog(err.stack ?? '(no stack)');
    process.exit(1);
  }

  // Auto-register groups from TARGET_GROUP_ID env var so they work immediately
  if (TARGET_GROUP_IDS.length > 0) {
    for (const gid of TARGET_GROUP_IDS) {
      registerGroup(gid, `Group ${gid}`);
      slog(`📥 Pre-registered group from env: ${gid}`);
    }
  } else {
    slog('ℹ️  No TARGET_GROUP_ID configured — groups will auto-register when bot is added.');
  }

  slog('Creating Telegraf bot instance...');
  const bot = new Telegraf(process.env.BOT_TOKEN!);

  // ─── Auto-register/deregister groups when bot membership changes ──────────
  bot.on('my_chat_member', (ctx) => {
    try {
      const update = ctx.update.my_chat_member;
      const chat = update.chat;
      if (chat.type !== 'group' && chat.type !== 'supergroup') return;

      const newStatus = update.new_chat_member.status;
      const title = (chat as any).title || `Group ${chat.id}`;

      if (newStatus === 'member' || newStatus === 'administrator') {
        registerGroup(chat.id, title);
        slog(`📥 Bot added to group: ${title} (${chat.id})`);
      } else if (newStatus === 'kicked' || newStatus === 'left') {
        deactivateGroup(chat.id);
        slog(`🚫 Bot removed from group: ${title} (${chat.id})`);
      }
    } catch (err: any) {
      slog(`⚠️  my_chat_member handler error: ${err.message}`);
    }
  });

  slog('Registering admin commands...');
  registerAdminCommands(bot);

  slog('Registering user commands...');
  registerUserCommands(bot);

  // ─── Global error handler ────────────────────────────────────────────────
  bot.catch((err: any, ctx) => {
    const msg: string = err?.message ?? '';

    // Ignore stale callback queries (old button clicks after restart)
    if (msg.includes('query is too old') || msg.includes('query ID is invalid')) {
      return;
    }

    slog(`❌ Bot error for ${ctx.updateType}: ${msg}`);
    console.error(err.stack);
    try { ctx.reply(`❌ An error occurred: ${msg}`); } catch {}
  });

  // ─── Cron: hourly heartbeat ──────────────────────────────────────────────
  cron.schedule('0 * * * *', () => {
    slog(`🕐 Heartbeat: bot is alive`);
  });

  // ─── Graceful shutdown ───────────────────────────────────────────────────
  // MUST be registered BEFORE bot.launch(). Since `await bot.launch()` never
  // returns during normal operation (it blocks until the bot stops), any code
  // placed after it never executes — including SIGTERM/SIGINT handlers.
  // Without this, Node.js default behaviour kills the process immediately on
  // SIGTERM with no graceful cleanup, causing 409 conflicts on the next start.
  const shutdown = (signal: string) => {
    slog(`⚠️  Received ${signal}, shutting down gracefully...`);
    bot.stop(signal);
    setTimeout(() => {
      slog('Process exiting.');
      process.exit(0);
    }, 4000);
  };
  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // ─── Launch bot (with 409 retry) ─────────────────────────────────────────
  // Runs as a background IIFE so main() can return and the SIGTERM handlers
  // above remain active. When cPanel restarts, the old process may still be
  // polling Telegram for a few seconds — we retry up to 5 times with a 6s
  // delay. The old process exits within 4s (SIGTERM timeout), so attempt 2
  // or 3 always succeeds.
  const MAX_LAUNCH_RETRIES = 5;
  const LAUNCH_RETRY_DELAY_MS = 6000;

  slog('Launching Telegraf (dropPendingUpdates=true)...');
  (async () => {
    for (let attempt = 1; attempt <= MAX_LAUNCH_RETRIES; attempt++) {
      try {
        await bot.launch({ dropPendingUpdates: true });
        slog('✅ Bot polling stopped (graceful shutdown complete).');
        return;
      } catch (err: any) {
        const is409 = err.message?.includes('409');
        if (is409 && attempt < MAX_LAUNCH_RETRIES) {
          slog(`⚠️  409 Conflict (attempt ${attempt}/${MAX_LAUNCH_RETRIES}) — old instance still stopping. Retrying in ${LAUNCH_RETRY_DELAY_MS / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, LAUNCH_RETRY_DELAY_MS));
        } else {
          slog(`❌ bot.launch() failed (attempt ${attempt}/${MAX_LAUNCH_RETRIES}): ${err.message}`);
          slog(err.stack ?? '(no stack)');
          process.exit(1);
        }
      }
    }
  })();

  slog('✅ Bot is launching (SIGTERM/SIGINT handlers active).');
  slog(`👑 Admins     : ${process.env.ADMIN_IDS}`);
  slog(`👥 Groups     : ${process.env.TARGET_GROUP_ID}`);
  slog(`🗄️  DB path    : ${process.env.DB_PATH ?? './data/predictions.db (relative — set absolute path in cPanel!)'}`);
  slog(`📁 Log dir    : ${LOG_DIR}`);
  slog('🚀 Football Prediction Bot started.');
}

main().catch(err => {
  slog(`💥 Fatal error in main(): ${err.message}`);
  slog(err.stack ?? '(no stack)');
  process.exit(1);
});
