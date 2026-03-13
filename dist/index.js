"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const telegraf_1 = require("telegraf");
const node_cron_1 = __importDefault(require("node-cron"));
const database_1 = require("./database");
const userCommands_1 = require("./userCommands");
const adminCommands_1 = require("./adminCommands");
// ─── Validate required env vars ───────────────────────────────────────────────
const requiredEnvVars = ['BOT_TOKEN', 'ADMIN_IDS', 'TARGET_GROUP_ID', 'FOOTBALL_DATA_API_KEY'];
for (const key of requiredEnvVars) {
    if (!process.env[key]) {
        console.error(`❌ Missing required environment variable: ${key}`);
        console.error('Please copy .env.example to .env and fill in your values.');
        process.exit(1);
    }
}
// ─── Init DB ─────────────────────────────────────────────────────────────────
(0, database_1.initDatabase)();
// ─── Init Bot ────────────────────────────────────────────────────────────────
const bot = new telegraf_1.Telegraf(process.env.BOT_TOKEN);
// IMPORTANT: Admin commands must be registered BEFORE user commands
// because userCommands has a bot.on('text') catch-all handler that
// must come last, otherwise it intercepts admin command messages.
(0, adminCommands_1.registerAdminCommands)(bot);
(0, userCommands_1.registerUserCommands)(bot);
// ─── Global error handler ─────────────────────────────────────────────────────
bot.catch((err, ctx) => {
    console.error(`❌ Bot error for ${ctx.updateType}:`, err.message);
    console.error(err.stack);
    try {
        ctx.reply(`❌ An error occurred: ${err.message}`);
    }
    catch { }
});
// ─── Cron: heartbeat log ──────────────────────────────────────────────────────
node_cron_1.default.schedule('0 * * * *', () => {
    console.log(`🕐 Bot heartbeat: ${new Date().toISOString()}`);
});
// ─── Launch ──────────────────────────────────────────────────────────────────
bot.launch().then(() => {
    console.log('🚀 Football Prediction Bot is running!');
    console.log(`👑 Admins: ${process.env.ADMIN_IDS}`);
    console.log(`👥 Target Group: ${process.env.TARGET_GROUP_ID}`);
    console.log(`🔑 Football API key set: ${!!process.env.FOOTBALL_DATA_API_KEY}`);
});
// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
