import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import { initDatabase } from './database';
import { registerUserCommands } from './userCommands';
import { registerAdminCommands } from './adminCommands';

// ─── Startup logger ───────────────────────────────────────────────────────────
// Writes every step to logs/startup.log AND console so you can diagnose
// cPanel launch failures by checking the file even if stdout isn't captured.

const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
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

  slog('Creating Telegraf bot instance...');
  const bot = new Telegraf(process.env.BOT_TOKEN!);

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

  // ─── Launch bot ──────────────────────────────────────────────────────────
  slog('Launching Telegraf (dropPendingUpdates=true)...');
  try {
    await bot.launch({ dropPendingUpdates: true });
    slog('✅ Bot launched and polling Telegram API.');
    slog(`👑 Admins     : ${process.env.ADMIN_IDS}`);
    slog(`👥 Group      : ${process.env.TARGET_GROUP_ID}`);
    slog(`🗄️  DB path    : ${process.env.DB_PATH ?? './data/predictions.db'}`);
    slog(`📁 Log dir    : ${LOG_DIR}`);
    slog('🚀 Football Prediction Bot is running!');
  } catch (err: any) {
    slog(`❌ bot.launch() failed: ${err.message}`);
    slog(err.stack ?? '(no stack)');
    process.exit(1);
  }

  // ─── Graceful shutdown ───────────────────────────────────────────────────
  // process.exit() is required because node-cron keeps the event loop alive
  // after bot.stop(), causing cPanel to see a zombie that never fully exits.
  const shutdown = (signal: string) => {
    slog(`⚠️  Received ${signal}, shutting down gracefully...`);
    bot.stop(signal);
    setTimeout(() => {
      slog('Process exiting.');
      process.exit(0);
    }, 2000);
  };

  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  slog(`💥 Fatal error in main(): ${err.message}`);
  slog(err.stack ?? '(no stack)');
  process.exit(1);
});
