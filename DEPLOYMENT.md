# Deployment Guide — cPanel Hosting

This guide covers deploying the Football Prediction Bot to a cPanel hosting environment. The bot uses an **esbuild bundle** approach — everything is compiled locally and pushed to GitHub, so the server never needs to run `npm install` or compile TypeScript.

---

## How the deployment works

```
Local Mac  →  npm run build  →  dist/bundle.js + dist/sql-wasm.wasm
     ↓
   git push
     ↓
 Server  →  git pull  →  node dist/bundle.js
```

- All dependencies (telegraf, sql.js, axios, etc.) are bundled into one file
- SQLite runs as pure WebAssembly — no native compilation needed
- The server just runs a single Node.js file

---

## First-time setup

### Step 1 — Build locally on your Mac

```bash
cd GuessTheScore
npm install
npm run build
```

Verify the output:
```bash
ls dist/
# Should show: bundle.js  sql-wasm.wasm
```

### Step 2 — Push to GitHub

```bash
git add .
git commit -m "Initial build"
git push
```

### Step 3 — Clone the repo on the server via cPanel

1. Log into **cPanel**
2. Go to **Git Version Control**
3. Click **Create**
4. Fill in:
   - **Clone URL:** `https://github.com/massbeat/GuessTheScore.git`
   - **Repository Path:** `/home2/YOUR_USERNAME/repositories/GuessTheScore`
   - **Repository Name:** `GuessTheScore`
5. Click **Create** — cPanel will clone the repo automatically

### Step 4 — Create the `.env` file on the server

Connect via SSH (cPanel → SSH Access, or use the Terminal in cPanel), then:

```bash
cd ~/repositories/GuessTheScore
cp .env.example .env
nano .env
```

Fill in your values:

```env
BOT_TOKEN=your_telegram_bot_token
ADMIN_IDS=your_telegram_user_id
TARGET_GROUP_ID=-your_group_chat_id
FOOTBALL_DATA_API_KEY=your_api_key
DB_PATH=/home2/YOUR_USERNAME/repositories/GuessTheScore/data/predictions.db
LOG_DIR=/home2/YOUR_USERNAME/repositories/GuessTheScore/logs
```

Save with `Ctrl+X → Y → Enter`.

Create the required directories:
```bash
mkdir -p data logs
```

### Step 5 — Set up the Node.js App in cPanel

1. Go to **cPanel → Setup Node.js App**
2. Click **Create Application**
3. Configure:

| Field | Value |
|-------|-------|
| Node.js version | 22 (or highest available) |
| Application mode | Production |
| Application root | `/home2/YOUR_USERNAME/repositories/GuessTheScore` |
| Application startup file | `dist/bundle.js` |

4. Click **Create**

### Step 6 — Add environment variables in cPanel

On the Node.js App edit page, scroll to **Environment Variables** and add:

| Key | Value |
|-----|-------|
| `BOT_TOKEN` | your telegram bot token |
| `ADMIN_IDS` | your telegram user id |
| `TARGET_GROUP_ID` | your group chat id (negative number) |
| `FOOTBALL_DATA_API_KEY` | your football-data.org api key |
| `DB_PATH` | `/home2/YOUR_USERNAME/repositories/GuessTheScore/data/predictions.db` |
| `LOG_DIR` | `/home2/YOUR_USERNAME/repositories/GuessTheScore/logs` |

Click **Save**.

### Step 7 — Start the bot

Click **Start** (or **Restart**) in the Node.js App panel.

The bot is now running 24/7.

---

## Verifying it works

Test manually via SSH to see live output:

```bash
cd ~/repositories/GuessTheScore
source ~/nodevenv/repositories/GuessTheScore/22/bin/activate
node dist/bundle.js
```

You should see:
```
✅ Database initialized
🚀 Football Prediction Bot is running!
```

Press `Ctrl+C` to stop the manual run, then restart via cPanel.

---

## Updating after code changes

Every time you update the bot code, do this on your **local Mac**:

```bash
npm run build
git add dist/bundle.js dist/sql-wasm.wasm src/ package.json
git commit -m "Update: describe your change"
git push
```

Then on the **server** (SSH or cPanel Terminal):

```bash
cd ~/repositories/GuessTheScore
git pull
```

Then in **cPanel → Setup Node.js App → Restart**.

---

## Configuration reference

All configuration is done via environment variables in the `.env` file or the cPanel environment variables panel.

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Telegram bot token from [@BotFather](https://t.me/BotFather) |
| `ADMIN_IDS` | Yes | Comma-separated Telegram user IDs with admin access |
| `TARGET_GROUP_ID` | Yes | Chat ID of the Telegram group (negative number) |
| `FOOTBALL_DATA_API_KEY` | Yes | API key from [football-data.org](https://www.football-data.org/client/register) |
| `DB_PATH` | Yes | Full path to the SQLite database file |
| `LOG_DIR` | Yes | Directory for admin action log files |

### Getting your credentials

**Telegram Bot Token:**
1. Start a chat with [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the token it gives you

**Admin Telegram ID:**
1. Start a chat with [@userinfobot](https://t.me/userinfobot)
2. It will reply with your numeric user ID

**Group Chat ID:**
1. Add your bot to the group
2. Send a message in the group
3. Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
4. Find `"chat":{"id":...}` — it's a negative number like `-1001234567890`

**Football Data API Key:**
1. Register at [football-data.org](https://www.football-data.org/client/register)
2. The free tier covers all major leagues (Premier League, Champions League, Bundesliga, La Liga, Serie A, Ligue 1)

---

## Checking logs and errors

**Admin action log** — all admin actions are recorded here with timestamps:
```bash
tail -f ~/repositories/GuessTheScore/logs/admin.log
```

Example log entries:
```
[2026-03-13T10:22:01.000Z] ADMIN:395441 | FETCH_MATCHES | code=PL matchday=upcoming count=10
[2026-03-13T10:22:45.000Z] ADMIN:395441 | ACTIVATE_MATCH | matchId=12345 Arsenal vs Chelsea
[2026-03-13T18:05:12.000Z] ADMIN:395441 | FINALIZE_MATCH | matchId=12345 Arsenal 2-1 Chelsea
```

**Live error output** — run the bot manually to see errors in real time:
```bash
cd ~/repositories/GuessTheScore
source ~/nodevenv/repositories/GuessTheScore/22/bin/activate
node dist/bundle.js
```

---

## Backup and restore

**Backup the database:**
```bash
cp ~/repositories/GuessTheScore/data/predictions.db \
   ~/predictions_backup_$(date +%Y%m%d_%H%M%S).db
```

**Restore from backup:**
```bash
cp ~/predictions_backup_YYYYMMDD_HHMMSS.db \
   ~/repositories/GuessTheScore/data/predictions.db
```

Then restart the bot in cPanel.

---

## Troubleshooting

**Bot doesn't start:**
Run `node dist/bundle.js` manually via SSH — the error will print directly to the terminal.

**"Access Denied" for all users:**
Verify `TARGET_GROUP_ID` is correct (negative number for groups) and the bot is an **Administrator** in the group.

**API returns no matches:**
Check your `FOOTBALL_DATA_API_KEY` at [football-data.org](https://www.football-data.org). Use `/admin_competitions` to see what leagues are available on your plan.

**Database errors on startup:**
Run `mkdir -p ~/repositories/GuessTheScore/data` and verify `DB_PATH` points to that directory.

**Log directory errors:**
Run `mkdir -p ~/repositories/GuessTheScore/logs` and verify `LOG_DIR` is set correctly.
