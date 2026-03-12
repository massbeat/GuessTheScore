# Deployment Guide — Football Prediction Bot

## Prerequisites

- A VPS (Ubuntu 22.04+ recommended) with SSH access
- Docker and Docker Compose installed on the VPS
- A GitHub account with access to https://github.com/massbeat/GuessTheScore
- Your `.env` values ready (BOT_TOKEN, ADMIN_IDS, TARGET_GROUP_ID, FOOTBALL_DATA_API_KEY)

---

## Part 1: Push Code to GitHub

Run these commands **on your local machine** from the project folder:

```bash
# 1. Initialize git (if not already)
cd /path/to/football-prediction-bot
git init

# 2. Add the remote
git remote add origin https://github.com/massbeat/GuessTheScore.git

# 3. Stage all files (.gitignore will exclude node_modules, .env, dist, data)
git add -A

# 4. Verify what will be committed (make sure .env is NOT listed)
git status

# 5. Commit
git commit -m "Initial commit: Football Prediction Bot"

# 6. Push to main branch
git branch -M main
git push -u origin main
```

If the repo already has content and you get a rejection, use:
```bash
git push -u origin main --force
```

---

## Part 2: Set Up the VPS

### 2.1 — Install Docker (if not already installed)

SSH into your VPS and run:

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh

# Add your user to the docker group (avoids needing sudo)
sudo usermod -aG docker $USER

# Install Docker Compose plugin
sudo apt install docker-compose-plugin -y

# Log out and back in for group change to take effect
exit
```

SSH back in and verify:
```bash
docker --version
docker compose version
```

### 2.2 — Clone the Repo

```bash
cd ~
git clone https://github.com/massbeat/GuessTheScore.git
cd GuessTheScore
```

### 2.3 — Create the .env File

```bash
cp .env.example .env
nano .env
```

Fill in your actual values:
```
BOT_TOKEN=your_bot_token_from_botfather
ADMIN_IDS=your_telegram_user_id
TARGET_GROUP_ID=your_group_chat_id
FOOTBALL_DATA_API_KEY=your_api_key
DB_PATH=./data/predictions.db
```

Save and exit (Ctrl+X, Y, Enter).

### 2.4 — Build and Start the Bot

```bash
docker compose up -d --build
```

This will:
- Build the Docker image (install dependencies, compile TypeScript)
- Start the bot in the background
- Persist the SQLite database in a Docker volume

### 2.5 — Verify It's Running

```bash
# Check container status
docker compose ps

# View logs
docker compose logs -f

# You should see:
# ✅ Database initialized
# 🚀 Football Prediction Bot is running!
```

Press Ctrl+C to exit the log viewer (the bot keeps running).

---

## Part 3: Managing the Bot

### View logs
```bash
cd ~/GuessTheScore
docker compose logs -f --tail 100
```

### Stop the bot
```bash
docker compose down
```

### Restart the bot
```bash
docker compose restart
```

### Update after code changes

On your local machine, push changes:
```bash
git add -A
git commit -m "Description of changes"
git push
```

On the VPS, pull and rebuild:
```bash
cd ~/GuessTheScore
git pull
docker compose up -d --build
```

### Backup the database

The SQLite database lives in a Docker volume. To back it up:
```bash
# Find the volume
docker volume inspect guessthescore_bot-data

# Copy the db file out
docker cp football-prediction-bot:/app/data/predictions.db ~/predictions-backup.db
```

### Restore from backup
```bash
docker cp ~/predictions-backup.db football-prediction-bot:/app/data/predictions.db
docker compose restart
```

---

## Troubleshooting

**Bot won't start — missing env vars:**
```bash
docker compose logs | head -20
# Look for: ❌ Missing required environment variable
# Fix: edit .env and rebuild
```

**Container keeps restarting:**
```bash
docker compose logs --tail 50
# Check for errors, then fix and rebuild
docker compose up -d --build
```

**Permission denied on Docker:**
```bash
sudo usermod -aG docker $USER
# Log out and back in
```

**Port conflict (if you add a health endpoint later):**
```bash
# Check what's using the port
sudo lsof -i :3000
```
