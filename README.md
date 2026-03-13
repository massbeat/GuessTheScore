# ⚽ Football Prediction Bot

A Telegram bot for running football score prediction competitions within a group. Users predict match scores, earn points, and compete on a leaderboard.

> ☕ If you find this useful, [buy me a coffee](https://buymeacoffee.com/massbeat)!

---

## ✨ Features

- Users predict exact scores for active matches via inline buttons
- Predictions lock automatically 5 minutes before kickoff
- Points awarded: 3 for exact score, 2 for correct goal difference, 1 for correct outcome
- Live leaderboard posted in the group
- Admin panel for fetching matches from football-data.org API
- Private DM responses — predictions stay hidden from other users
- SQLite database — no external database needed
- Bundled into a single file for easy deployment on any host

---

## 🛠 Local Installation

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A free API key from [football-data.org](https://www.football-data.org/client/register)

### Step 1 — Clone the repo

```bash
git clone https://github.com/massbeat/GuessTheScore.git
cd GuessTheScore
```

### Step 2 — Install dependencies

```bash
npm install
```

### Step 3 — Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in all values:

```env
BOT_TOKEN=your_telegram_bot_token
ADMIN_IDS=123456789
TARGET_GROUP_ID=-1001234567890
FOOTBALL_DATA_API_KEY=your_api_key
DB_PATH=./data/predictions.db
LOG_DIR=./logs
```

#### How to get your Telegram User ID
Start a chat with [@userinfobot](https://t.me/userinfobot) — it replies with your ID instantly.

#### How to get your Group Chat ID
1. Add your bot to the group
2. Send any message in the group
3. Open: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. Find `"chat":{"id":...}` in the response — it's a negative number like `-1001234567890`

#### How to get a Football Data API key
Register for free at [football-data.org](https://www.football-data.org/client/register). The free tier covers the major leagues (Premier League, Champions League, Bundesliga, La Liga, Serie A, Ligue 1).

### Step 4 — Build and run

**Development (live reload):**
```bash
npm run dev
```

**Production (build then run):**
```bash
npm run build
npm start
```

---

## 📋 Commands Reference

### 👤 User Commands

| Command | Description |
|---------|-------------|
| `/start` | Register and see welcome message |
| `/help` | Show all commands and scoring rules |
| `/matches` | List open fixtures with Predict buttons |
| `/missing` | Matches you haven't predicted yet |
| `/mypicks` | Your current active predictions |
| `/mystats` | Your total points and prediction history |
| `/leaderboard` | Top 20 players posted in the group |

### 👑 Admin Commands

| Command | Description |
|---------|-------------|
| `/admin_competitions` | Browse all competitions with buttons |
| `/admin_fetch <code> [matchday]` | Fetch matches by competition code |
| `/admin_active` | List currently active matches |
| `/admin_update <match_id>` | Fetch score from API and award points |
| `/admin_manual_score <id> <home>-<away>` | Set score manually |
| `/admin_clearleaderboard` | Reset all scores and predictions |
| `/admin_clearmatchday` | Deactivate all active matches |
| `/admin_resetfinished` | Reset finished matches back to pending |

**Free tier competition codes:**

| Code | League |
|------|--------|
| `PL` | Premier League |
| `CL` | Champions League |
| `BL1` | Bundesliga |
| `SA` | Serie A |
| `PD` | La Liga |
| `FL1` | Ligue 1 |
| `DED` | Eredivisie |
| `PPL` | Primeira Liga |

---

## 🏆 Scoring System

| Result | Points |
|--------|--------|
| 🎯 Exact score | 3 pts |
| ✅ Correct goal difference | 2 pts |
| 👍 Correct outcome (win/draw/loss) | 1 pt |
| ❌ Wrong outcome | 0 pts |

**Examples:**

| Your Prediction | Actual Result | Points | Reason |
|-----------------|---------------|--------|--------|
| 2-1 | 2-1 | **3** | Exact score |
| 2-1 | 3-2 | **2** | Both home win by 1 goal |
| 1-1 | 2-2 | **2** | Both draws |
| 1-0 | 3-0 | **1** | Correct winner, wrong margin |
| 2-1 | 0-1 | **0** | Wrong outcome |

---

## 🎮 Admin Workflow

### 1. Before matchday — add matches

```
/admin_competitions
```
Browse competitions and click a button to load its fixtures. Toggle ✅/⬜ to activate matches for prediction.

Or fetch directly by code:
```
/admin_fetch PL        ← all upcoming Premier League matches
/admin_fetch CL 8      ← Champions League matchday 8
```

### 2. During matchday — users predict

Users type `/matches` or `/missing` to see open fixtures and submit predictions via inline buttons. Predictions lock 5 minutes before kickoff.

### 3. After matches — finalize results

```
/admin_update 856291
```
Fetches the score from the API, calculates points, and posts results.

If the API is unavailable:
```
/admin_manual_score 856291 2-1
```

---

## 🗂 Project Structure

```
GuessTheScore/
├── src/
│   ├── index.ts           # Entry point, bot setup
│   ├── database.ts        # SQLite schema and all queries
│   ├── footballApi.ts     # football-data.org API client
│   ├── userCommands.ts    # User-facing commands
│   ├── adminCommands.ts   # Admin-only commands
│   ├── scoring.ts         # Points calculation logic
│   ├── helpers.ts         # Utilities (auth, formatting, DMs)
│   └── logger.ts          # Admin action logging
├── dist/
│   ├── bundle.js          # Pre-built production bundle
│   └── sql-wasm.wasm      # SQLite WebAssembly binary
├── data/                  # SQLite database (auto-created, gitignored)
├── logs/                  # Admin action logs (auto-created, gitignored)
├── .env.example           # Environment variable template
├── package.json
└── tsconfig.json
```

---

## 🔒 Important Notes

- The bot must be an **Administrator** in the group for membership checks to work on private groups
- Predictions are sent via **private DM** — other users cannot see individual predictions
- `/mystats` and `/leaderboard` post in the group so everyone can see standings
- The database is a single SQLite file stored in `./data/predictions.db`
- Admin actions are logged to `./logs/admin.log` with timestamps

---

## 🚀 Deploying to a Server

See [DEPLOYMENT.md](./DEPLOYMENT.md) for full step-by-step instructions for deploying to cPanel hosting.

---

## ☕ Support

If this bot brings joy to your group, consider supporting the project:

[Buy Me a Coffee ☕](https://buymeacoffee.com/massbeat)
