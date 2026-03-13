# Deployment Guide — cPanel Hosting

This bot uses **esbuild** to bundle the entire app (including all dependencies) into
a single `dist/bundle.js` file. This means the server never needs to run `npm install`.

---

## How it works

- You build locally on your Mac → produces `dist/bundle.js` + `dist/sql-wasm.wasm`
- You push those files to GitHub
- The server pulls from GitHub and runs the bundle directly
- No Docker, no npm install, no compilation needed on the server

---

## First-time setup

### 1. Local Mac — install and build

```bash
npm install
npm run build
```

Verify `dist/bundle.js` and `dist/sql-wasm.wasm` were created:
```bash
ls dist/
```

### 2. Push to GitHub

```bash
git add .
git commit -m "Initial deployment build"
git push
```

### 3. Server — clone the repo via cPanel Git

1. Log into cPanel
2. Go to **Git Version Control**
3. Click **Create**
4. Fill in:
   - Clone URL: `https://github.com/massbeat/GuessTheScore.git`
   - Repository Path: `/home2/YOUR_USERNAME/repositories/GuessTheScore`
5. Click **Create**

### 4. Server — create the .env file via SSH

Connect via SSH (or use cPanel Terminal), then:

```bash
cd ~/repositories/GuessTheScore
cp .env.example .env
nano .env
```

Fill in your values:
```
BOT_TOKEN=your_telegram_bot_token
ADMIN_IDS=your_telegram_user_id
TARGET_GROUP_ID=-your_group_chat_id
FOOTBALL_DATA_API_KEY=your_api_key
DB_PATH=/home2/YOUR_USERNAME/repositories/GuessTheScore/data/predictions.db
```

Save with `Ctrl+X → Y → Enter`, then create the data folder:
```bash
mkdir -p data
```

### 5. cPanel — set up the Node.js App

1. Go to cPanel → **Setup Node.js App**
2. Click **Create Application**
3. Fill in:
   - **Node.js version:** 22 (or highest available)
   - **Application mode:** Production
   - **Application root:** `/home2/YOUR_USERNAME/repositories/GuessTheScore`
   - **Application startup file:** `dist/bundle.js`
4. Click **Create**

### 6. cPanel — add environment variables

On the Node.js App edit page, add these under **Environment Variables**:

| Key | Value |
|-----|-------|
| `BOT_TOKEN` | your telegram bot token |
| `ADMIN_IDS` | your telegram user id |
| `TARGET_GROUP_ID` | your group chat id |
| `FOOTBALL_DATA_API_KEY` | your api key |
| `DB_PATH` | `/home2/YOUR_USERNAME/repositories/GuessTheScore/data/predictions.db` |

### 7. Start the bot

In cPanel → **Setup Node.js App** → click **Start**.

The bot is now running 24/7.

---

## Updating after code changes

Every time you change the code, do this on your **local Mac**:

```bash
npm run build
git add dist/bundle.js dist/sql-wasm.wasm
git add src/          # if you changed source files
git commit -m "Update bot"
git push
```

Then on the **server** (via SSH or cPanel Terminal):

```bash
cd ~/repositories/GuessTheScore
git pull
```

Then in cPanel → **Setup Node.js App** → click **Restart**.

---

## Useful SSH commands

```bash
# Check if bot process is running
ps aux | grep bundle.js

# View app logs (path shown in cPanel Node.js App page)
tail -f ~/logs/GuessTheScore.log

# Manually test the bundle
cd ~/repositories/GuessTheScore
source ~/nodevenv/repositories/GuessTheScore/22/bin/activate
node dist/bundle.js
```

## Backup the database

```bash
cp ~/repositories/GuessTheScore/data/predictions.db ~/predictions_backup_$(date +%Y%m%d).db
```
