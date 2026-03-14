import 'dotenv/config';
import http from 'http';
import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import { initDatabase } from './database';
import { registerUserCommands } from './userCommands';
import { registerAdminCommands } from './adminCommands';

// ─── Validate required env vars ───────────────────────────────────────────────
const requiredEnvVars = ['BOT_TOKEN', 'ADMIN_IDS', 'TARGET_GROUP_ID', 'FOOTBALL_DATA_API_KEY'];
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    console.error('Please copy .env.example to .env and fill in your values.');
    process.exit(1);
  }
}

// ─── HTTP server required by cPanel Passenger ─────────────────────────────────
// cPanel runs Node.js apps via Phusion Passenger which expects an HTTP server
// to start listening. Without this, Passenger kills the process after ~10s.
// The PORT env var is set automatically by Passenger.
const port = parseInt(process.env.PORT || '3000', 10);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Football Prediction Bot is running\n');
}).listen(port, () => {
  console.log(`🌐 HTTP server listening on port ${port} (required by Passenger)`);
});

async function main() {
  // ─── Init DB ───────────────────────────────────────────────────────────────
  await initDatabase();

  // ─── Init Bot ──────────────────────────────────────────────────────────────
  const bot = new Telegraf(process.env.BOT_TOKEN!);

  // IMPORTANT: Admin commands must be registered BEFORE user commands
  // because userCommands has a bot.on('text') catch-all handler that
  // must come last, otherwise it intercepts admin command messages.
  registerAdminCommands(bot);
  registerUserCommands(bot);

  // ─── Global error handler ──────────────────────────────────────────────────
  bot.catch((err: any, ctx) => {
    const msg: string = err?.message ?? '';

    // Ignore stale callback queries — happens when bot restarts and processes
    // button clicks that accumulated while it was offline (>30s old)
    if (msg.includes('query is too old') || msg.includes('query ID is invalid')) {
      return;
    }

    console.error(`❌ Bot error for ${ctx.updateType}:`, msg);
    console.error(err.stack);
    try {
      ctx.reply(`❌ An error occurred: ${msg}`);
    } catch {}
  });

  // ─── Cron: heartbeat log ───────────────────────────────────────────────────
  cron.schedule('0 * * * *', () => {
    console.log(`🕐 Bot heartbeat: ${new Date().toISOString()}`);
  });

  // ─── Launch ────────────────────────────────────────────────────────────────
  // dropPendingUpdates: skip button clicks / messages that arrived while the
  // bot was offline — prevents "query is too old" errors on every restart
  await bot.launch({ dropPendingUpdates: true });
  console.log('🚀 Football Prediction Bot is running!');
  console.log(`👑 Admins: ${process.env.ADMIN_IDS}`);
  console.log(`👥 Target Group: ${process.env.TARGET_GROUP_ID}`);
  console.log(`🔑 Football API key set: ${!!process.env.FOOTBALL_DATA_API_KEY}`);

  // Graceful stop — must call process.exit() after bot.stop() because
  // node-cron keeps the event loop alive and the process would otherwise
  // never exit, leaving cPanel unable to cleanly restart the app.
  const shutdown = (signal: string) => {
    console.log(`\n⚠️  Received ${signal}, shutting down...`);
    bot.stop(signal);
    // Give Telegraf 2 seconds to finish any in-flight requests, then exit
    setTimeout(() => process.exit(0), 2000);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
