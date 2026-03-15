import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
// WASM binary embedded by esbuild (--loader:.wasm=base64)
import sqlWasm from 'sql.js/dist/sql-wasm.wasm';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.DB_PATH || './data/predictions.db';

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db: Database;
let inTransaction = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function saveDb(): void {
  if (inTransaction) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function run(sql: string, params: any[] = []): number {
  db.run(sql, params);
  const changes = db.getRowsModified();
  saveDb();
  return changes;
}

function get(sql: string, params: any[] = []): any {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row: any = null;
  if (stmt.step()) { row = stmt.getAsObject(); }
  stmt.free();
  return row;
}

function all(sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) { rows.push(stmt.getAsObject()); }
  stmt.free();
  return rows;
}

function transaction(fn: () => void): void {
  inTransaction = true;
  db.run('BEGIN');
  try {
    fn();
    db.run('COMMIT');
    inTransaction = false;
    saveDb();
  } catch (err) {
    db.run('ROLLBACK');
    inTransaction = false;
    throw err;
  }
}

// ─── Migration: v1 → v2 (adds group_id to predictions) ───────────────────────

function migrateToV2(): void {
  // Check if group_id column already exists
  const stmt = db.prepare('PRAGMA table_info(predictions)');
  const cols: string[] = [];
  while (stmt.step()) {
    cols.push(stmt.getAsObject().name as string);
  }
  stmt.free();

  if (cols.includes('group_id')) return; // Already v2

  console.log('📦 Migrating database to v2 (multi-group support)...');
  db.exec(`
    CREATE TABLE predictions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_telegram_id INTEGER NOT NULL,
      match_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL DEFAULT 0,
      predicted_home_score INTEGER NOT NULL,
      predicted_away_score INTEGER NOT NULL,
      points_awarded INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_telegram_id, match_id, group_id)
    );
    INSERT OR IGNORE INTO predictions_new
      (id, user_telegram_id, match_id, group_id, predicted_home_score, predicted_away_score, points_awarded, created_at, updated_at)
    SELECT id, user_telegram_id, match_id, 0, predicted_home_score, predicted_away_score, points_awarded, created_at, updated_at
    FROM predictions;
    DROP TABLE predictions;
    ALTER TABLE predictions_new RENAME TO predictions;
  `);
  console.log('✅ Migration v2 complete — existing predictions assigned to legacy group (id=0)');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initDatabase(): Promise<void> {
  const wasmBinary = Buffer.from(sqlWasm, 'base64');
  const SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      total_points INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      league TEXT,
      kickoff_time DATETIME NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'finished')),
      actual_home_score INTEGER,
      actual_away_score INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Groups registered with the bot (auto-registered when bot is added)
    CREATE TABLE IF NOT EXISTS groups (
      group_id INTEGER PRIMARY KEY,
      group_name TEXT,
      is_active INTEGER DEFAULT 1,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Per-group membership and points (separate leaderboard per group)
    CREATE TABLE IF NOT EXISTS group_members (
      user_telegram_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL,
      total_points INTEGER DEFAULT 0,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_telegram_id, group_id)
    );

    -- Predictions now include group_id for multi-competition support
    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_telegram_id INTEGER NOT NULL,
      match_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL DEFAULT 0,
      predicted_home_score INTEGER NOT NULL,
      predicted_away_score INTEGER NOT NULL,
      points_awarded INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_telegram_id, match_id, group_id),
      FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id),
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
  `);

  // Migrate existing installations from v1 schema
  migrateToV2();

  saveDb();
  console.log('✅ Database initialized');
}

// ─── User queries ─────────────────────────────────────────────────────────────

export function upsertUser(telegramId: number, username: string | undefined, firstName: string): void {
  run(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `, [telegramId, username ?? null, firstName]);
}

export function getUser(telegramId: number) {
  return get('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
}

// ─── Group queries ────────────────────────────────────────────────────────────

export function registerGroup(groupId: number, groupName: string): void {
  run(`
    INSERT INTO groups (group_id, group_name, is_active)
    VALUES (?, ?, 1)
    ON CONFLICT(group_id) DO UPDATE SET
      group_name = excluded.group_name,
      is_active = 1
  `, [groupId, groupName]);
}

export function deactivateGroup(groupId: number): void {
  run('UPDATE groups SET is_active = 0 WHERE group_id = ?', [groupId]);
}

export function isRegisteredGroup(groupId: number): boolean {
  const row = get('SELECT group_id FROM groups WHERE group_id = ? AND is_active = 1', [groupId]);
  return row !== null;
}

export function getRegisteredGroups(): any[] {
  return all('SELECT * FROM groups WHERE is_active = 1 ORDER BY registered_at ASC');
}

// ─── Group membership ─────────────────────────────────────────────────────────

export function joinGroup(telegramId: number, groupId: number): void {
  run(`
    INSERT OR IGNORE INTO group_members (user_telegram_id, group_id)
    VALUES (?, ?)
  `, [telegramId, groupId]);
}

export function getUserGroups(telegramId: number): any[] {
  return all(`
    SELECT gm.group_id, gm.total_points, gm.joined_at, g.group_name, g.is_active
    FROM group_members gm
    JOIN groups g ON g.group_id = gm.group_id
    WHERE gm.user_telegram_id = ? AND g.is_active = 1
    ORDER BY gm.joined_at ASC
  `, [telegramId]);
}

export function hasAnyGroupMembership(telegramId: number): boolean {
  return getUserGroups(telegramId).length > 0;
}

// ─── Match queries ────────────────────────────────────────────────────────────

export function upsertMatch(match: {
  id: number;
  home_team: string;
  away_team: string;
  league: string;
  kickoff_time: string;
}): void {
  run(`
    INSERT INTO matches (id, home_team, away_team, league, kickoff_time)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      home_team = excluded.home_team,
      away_team = excluded.away_team,
      league = excluded.league,
      kickoff_time = excluded.kickoff_time
  `, [match.id, match.home_team, match.away_team, match.league, match.kickoff_time]);
}

export function activateMatch(matchId: number): void {
  run(`UPDATE matches SET status = 'active' WHERE id = ?`, [matchId]);
}

export function deactivateMatch(matchId: number): void {
  run(`UPDATE matches SET status = 'pending' WHERE id = ?`, [matchId]);
}

export function getMatch(matchId: number) {
  return get('SELECT * FROM matches WHERE id = ?', [matchId]);
}

export function getActiveMatches() {
  return all(`SELECT * FROM matches WHERE status = 'active' ORDER BY kickoff_time ASC`);
}

export function getPendingMatches() {
  return all(`SELECT * FROM matches WHERE status = 'pending' ORDER BY kickoff_time ASC`);
}

export function setMatchResult(matchId: number, homeScore: number, awayScore: number): void {
  run(`
    UPDATE matches SET status = 'finished', actual_home_score = ?, actual_away_score = ? WHERE id = ?
  `, [homeScore, awayScore, matchId]);
}

// ─── Prediction queries ───────────────────────────────────────────────────────

export function upsertPrediction(
  telegramId: number,
  matchId: number,
  groupId: number,
  homeScore: number,
  awayScore: number
): boolean {
  const existing = get(`
    SELECT p.points_awarded, m.status
    FROM predictions p
    JOIN matches m ON p.match_id = m.id
    WHERE p.user_telegram_id = ? AND p.match_id = ? AND p.group_id = ?
  `, [telegramId, matchId, groupId]);

  if (existing && (existing.status === 'finished' || existing.points_awarded !== null)) {
    return false;
  }

  run(`
    INSERT INTO predictions (user_telegram_id, match_id, group_id, predicted_home_score, predicted_away_score, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_telegram_id, match_id, group_id) DO UPDATE SET
      predicted_home_score = excluded.predicted_home_score,
      predicted_away_score = excluded.predicted_away_score,
      updated_at = datetime('now')
  `, [telegramId, matchId, groupId, homeScore, awayScore]);
  return true;
}

export function getPredictionsForMatch(matchId: number) {
  return all(`
    SELECT p.*, u.username, u.first_name
    FROM predictions p
    JOIN users u ON p.user_telegram_id = u.telegram_id
    WHERE p.match_id = ?
  `, [matchId]);
}

export function getUserPredictions(telegramId: number) {
  return all(`
    SELECT p.*, m.home_team, m.away_team, m.kickoff_time, m.actual_home_score, m.actual_away_score, m.status
    FROM predictions p
    JOIN matches m ON p.match_id = m.id
    WHERE p.user_telegram_id = ?
    ORDER BY m.kickoff_time DESC
    LIMIT 20
  `, [telegramId]);
}

export function awardPoints(
  predictionId: number,
  points: number,
  telegramId: number,
  groupId: number = 0
): void {
  transaction(() => {
    run(`UPDATE predictions SET points_awarded = ? WHERE id = ?`, [points, predictionId]);
    run(`UPDATE users SET total_points = total_points + ? WHERE telegram_id = ?`, [points, telegramId]);
    // Update per-group points if this prediction belongs to a real group
    if (groupId !== 0) {
      run(`
        UPDATE group_members SET total_points = total_points + ?
        WHERE user_telegram_id = ? AND group_id = ?
      `, [points, telegramId, groupId]);
    }
  });
}

// ─── Unpredicted / predicted matches per group ────────────────────────────────

export function getUnpredictedMatches(telegramId: number, groupId: number) {
  return all(`
    SELECT m.*
    FROM matches m
    WHERE m.status = 'active'
      AND m.id NOT IN (
        SELECT match_id FROM predictions
        WHERE user_telegram_id = ? AND group_id = ?
      )
    ORDER BY m.kickoff_time ASC
  `, [telegramId, groupId]);
}

export function getPredictedMatches(telegramId: number, groupId: number) {
  return all(`
    SELECT m.*, p.predicted_home_score, p.predicted_away_score
    FROM matches m
    JOIN predictions p ON p.match_id = m.id AND p.user_telegram_id = ? AND p.group_id = ?
    WHERE m.status = 'active'
    ORDER BY m.kickoff_time ASC
  `, [telegramId, groupId]);
}

// ─── Leaderboards ─────────────────────────────────────────────────────────────

/** Per-group leaderboard using group_members.total_points */
export function getGroupLeaderboard(groupId: number, limit = 20) {
  return all(`
    SELECT u.telegram_id, u.username, u.first_name, gm.total_points,
           COUNT(p.id) AS prediction_count
    FROM group_members gm
    JOIN users u ON u.telegram_id = gm.user_telegram_id
    LEFT JOIN predictions p ON p.user_telegram_id = gm.user_telegram_id
                            AND p.group_id = gm.group_id
                            AND p.points_awarded IS NOT NULL
    WHERE gm.group_id = ?
    GROUP BY gm.user_telegram_id
    ORDER BY gm.total_points DESC
    LIMIT ?
  `, [groupId, limit]);
}

/** Global leaderboard using users.total_points (sum across all groups) */
export function getGlobalLeaderboard(limit = 20) {
  return all(`
    SELECT u.telegram_id, u.username, u.first_name, u.total_points,
           COUNT(DISTINCT p.id) AS prediction_count
    FROM users u
    LEFT JOIN predictions p ON p.user_telegram_id = u.telegram_id AND p.points_awarded IS NOT NULL
    WHERE u.total_points > 0
    GROUP BY u.telegram_id
    ORDER BY u.total_points DESC
    LIMIT ?
  `, [limit]);
}

// Alias kept for backward compat with any callers
export const getLeaderboard = getGlobalLeaderboard;

// ─── Admin: finished unscored matches (for batch finalize) ───────────────────

export function getFinishedUnscoredMatches() {
  return all(`
    SELECT DISTINCT m.*
    FROM matches m
    JOIN predictions p ON p.match_id = m.id
    WHERE m.status = 'finished'
      AND m.actual_home_score IS NOT NULL
      AND p.points_awarded IS NULL
    ORDER BY m.kickoff_time ASC
  `);
}

// ─── Admin: clear all scores and predictions ──────────────────────────────────

export function clearAllScoresAndPredictions(): { usersReset: number; predictionsDeleted: number } {
  let usersReset = 0;
  let predictionsDeleted = 0;

  transaction(() => {
    predictionsDeleted = run(`DELETE FROM predictions`);
    usersReset = run(`UPDATE users SET total_points = 0`);
    run(`UPDATE group_members SET total_points = 0`);
  });

  return { usersReset, predictionsDeleted };
}

// ─── Admin: deactivate all active matches ─────────────────────────────────────

export function deactivateAllMatches(): number {
  return run(`UPDATE matches SET status = 'pending' WHERE status = 'active'`);
}

// ─── Admin: get finished matches ──────────────────────────────────────────────

export function getFinishedMatches() {
  return all(`SELECT * FROM matches WHERE status = 'finished' ORDER BY kickoff_time DESC`);
}

// ─── Admin: reset finished matches back to pending ────────────────────────────

export function resetFinishedMatches(): { matchesReset: number; predictionsCleared: number; pointsDeducted: number } {
  const finishedMatches = all(`SELECT id FROM matches WHERE status = 'finished'`);
  const matchIds = finishedMatches.map((m: any) => m.id);

  if (matchIds.length === 0) return { matchesReset: 0, predictionsCleared: 0, pointsDeducted: 0 };

  let matchesReset = 0;
  let predictionsCleared = 0;
  let pointsDeducted = 0;

  transaction(() => {
    for (const matchId of matchIds) {
      const predictions = all(`
        SELECT user_telegram_id, group_id, points_awarded
        FROM predictions
        WHERE match_id = ? AND points_awarded IS NOT NULL
      `, [matchId]);

      for (const pred of predictions) {
        run(`UPDATE users SET total_points = MAX(0, total_points - ?) WHERE telegram_id = ?`,
          [pred.points_awarded, pred.user_telegram_id]);
        if (pred.group_id !== 0) {
          run(`UPDATE group_members SET total_points = MAX(0, total_points - ?)
               WHERE user_telegram_id = ? AND group_id = ?`,
            [pred.points_awarded, pred.user_telegram_id, pred.group_id]);
        }
        pointsDeducted += pred.points_awarded;
      }

      predictionsCleared += run(`DELETE FROM predictions WHERE match_id = ?`, [matchId]);
    }

    matchesReset = run(`
      UPDATE matches SET status = 'pending', actual_home_score = NULL, actual_away_score = NULL
      WHERE status = 'finished'
    `);
  });

  return { matchesReset, predictionsCleared, pointsDeducted };
}
