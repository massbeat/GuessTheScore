# ⚽ Football Prediction Bot

A Telegram bot for running a football prediction competition within a specific group.

---

## 🚀 Quick Setup (Step by Step)

### Step 1: Prerequisites
- [Node.js](https://nodejs.org/) v18 or higher
- A Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- A [RapidAPI](https://rapidapi.com/) account with access to [API-Football](https://rapidapi.com/api-sports/api/api-football)

---

### Step 2: Install Dependencies

```bash
npm install
```

---

### Step 3: Configure Environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```
BOT_TOKEN=        ← Your bot token from @BotFather
ADMIN_IDS=        ← Your Telegram user ID (see below how to get it)
TARGET_GROUP_ID=  ← Your group chat ID (see below)
RAPIDAPI_KEY=     ← Your RapidAPI key
```

#### 🔍 How to get your Telegram User ID
1. Start a chat with [@userinfobot](https://t.me/userinfobot)
2. It will reply with your User ID

#### 🔍 How to get your Group Chat ID
**Option A (easiest):**
1. Add [@userinfobot](https://t.me/userinfobot) to your group
2. It will post the group's Chat ID (a negative number like `-1001234567890`)
3. Remove the bot after

**Option B:**
1. Add your bot to the group
2. Send any message in the group
3. Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. Find the `"chat":{"id":...}` value in the response

---

### Step 4: Build & Run

**Development (with ts-node):**
```bash
npm run dev
```

**Production (compiled):**
```bash
npm run build
npm start
```

---

## 📋 Bot Commands Reference

### 👤 User Commands
| Command | Description |
|---------|-------------|
| `/start` | Register and see help |
| `/matches` | List open fixtures |
| `/predict <id> <home>-<away>` | Submit/update prediction |
| `/mystats` | Your points and history |
| `/leaderboard` | Top 20 players |

**Example prediction:**
```
/predict 105 2-1
```
This predicts Home team wins 2-1 for match #105.

---

### 👑 Admin Commands
| Command | Description |
|---------|-------------|
| `/admin_fetch 2024-03-15` | Fetch fixtures from API for a date |
| `/admin_active` | Show currently active matches |
| `/admin_update <match_id>` | Fetch final score and award points |
| `/admin_manual_score <id> <home>-<away>` | Manually set score if API fails |

---

## 🎮 How to Run a Competition

### Admin Workflow:

1. **Before matchday:**
   ```
   /admin_fetch 2024-03-15
   ```
   Bot shows inline buttons — click to toggle ✅/⬜ each match you want in the competition.

2. **Users predict** using `/predict` until 5 minutes before kickoff (auto-locked).

3. **After matches end:**
   ```
   /admin_update 856291
   ```
   Bot fetches the score from API, calculates points, and posts results for all predictors.

   If API is down:
   ```
   /admin_manual_score 856291 2-1
   ```

---

## 🏆 Scoring System

| Result | Points |
|--------|--------|
| 🎯 Exact score | 3 pts |
| ✅ Correct goal difference | 2 pts |
| 👍 Correct outcome (win/draw/loss) | 1 pt |
| ❌ Wrong outcome | 0 pts |

**Examples:**
- Predict 2-1, Actual 2-1 → **3 pts** (exact)
- Predict 2-1, Actual 3-2 → **2 pts** (both home wins by 1)
- Predict 1-1, Actual 2-2 → **2 pts** (both draws)
- Predict 2-0, Actual 3-1 → **2 pts** (home wins by 2)
- Predict 1-0, Actual 3-0 → **1 pt** (correct winner, wrong diff)
- Predict 2-1, Actual 0-1 → **0 pts** (wrong outcome)

---

## 🗂 Project Structure

```
football-prediction-bot/
├── src/
│   ├── index.ts          # Entry point, bot setup
│   ├── database.ts       # SQLite DB schema & queries
│   ├── footballApi.ts    # API-Football client
│   ├── userCommands.ts   # /start, /matches, /predict, etc.
│   ├── adminCommands.ts  # /admin_fetch, /admin_update, etc.
│   ├── scoring.ts        # Points calculation
│   └── helpers.ts        # Utilities (admin check, lockout, etc.)
├── data/
│   └── predictions.db    # SQLite database (auto-created)
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 🔒 Group Membership Check

The bot calls Telegram's `getChatMember` API to verify that users are in your target group before allowing any actions. Non-members get an "Access Denied" message.

**Important:** The bot must be an **Administrator** in your group for membership checks to work on private groups.

---

## 🛠 Troubleshooting

**Bot doesn't respond:**
- Check `BOT_TOKEN` is correct
- Make sure bot is not already running in another process

**"Access Denied" for all users:**
- Make sure `TARGET_GROUP_ID` is correct (usually a negative number)
- Make sure the bot is an admin in the group

**API fetch returns nothing:**
- Verify your `RAPIDAPI_KEY` on rapidapi.com
- Check your RapidAPI subscription for API-Football

**Predictions not locking:**
- `kickoff_time` is stored in UTC; ensure your system clock is accurate

---

## ☁️ Deploying to a Server

For 24/7 operation, deploy to a VPS (e.g. DigitalOcean, Hetzner) and use PM2:

```bash
npm install -g pm2
npm run build
pm2 start dist/index.js --name football-bot
pm2 save
pm2 startup
```
