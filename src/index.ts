import 'dotenv/config';
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

  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
