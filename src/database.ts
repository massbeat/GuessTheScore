import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.DB_PATH || './data/predictions.db';

// Ensure directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db: Database;
let inTransaction = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Save in-memory database to disk (skipped mid-transaction)
function saveDb(): void {
  if (inTransaction) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

// Execute SQL with params, return number of rows modified
function run(sql: string, params: any[] = []): number {
  db.run(sql, params);
  const changes = db.getRowsModified();
  saveDb();
  return changes;
}

// Get a single row as an object (or null)
function get(sql: string, params: any[] = []): any {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row: any = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

// Get all rows as an array of objects
function all(sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// Wrap multiple operations in a single atomic transaction
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

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initDatabase(): Promise<void> {
  // Locate the WASM file next to the running script (works for both bundle and dev)
  // __dirname in the esbuild bundle resolves to the directory of dist/bundle.js
  // at runtime — this is more reliable than process.argv[1] under cPanel Passenger
  // which may use a wrapper script as argv[1].
  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(__dirname, file)
  });

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

    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_telegram_id INTEGER NOT NULL,
      match_id INTEGER NOT NULL,
      predicted_home_score INTEGER NOT NULL,
      predicted_away_score INTEGER NOT NULL,
      points_awarded INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_telegram_id, match_id),
      FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id),
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
  `);

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
  homeScore: number,
  awayScore: number
): boolean {
  // Prevent updating predictions for finished matches or those already scored
  const existing = get(`
    SELECT p.points_awarded, m.status
    FROM predictions p
    JOIN matches m ON p.match_id = m.id
    WHERE p.user_telegram_id = ? AND p.match_id = ?
  `, [telegramId, matchId]);

  if (existing && (existing.status === 'finished' || existing.points_awarded !== null)) {
    return false;
  }

  run(`
    INSERT INTO predictions (user_telegram_id, match_id, predicted_home_score, predicted_away_score, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_telegram_id, match_id) DO UPDATE SET
      predicted_home_score = excluded.predicted_home_score,
      predicted_away_score = excluded.predicted_away_score,
      updated_at = datetime('now')
  `, [telegramId, matchId, homeScore, awayScore]);
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

export function awardPoints(predictionId: number, points: number, telegramId: number): void {
  transaction(() => {
    run(`UPDATE predictions SET points_awarded = ? WHERE id = ?`, [points, predictionId]);
    run(`UPDATE users SET total_points = total_points + ? WHERE telegram_id = ?`, [points, telegramId]);
  });
}

// ─── Unpredicted matches ──────────────────────────────────────────────────────

export function getUnpredictedMatches(telegramId: number) {
  return all(`
    SELECT m.*
    FROM matches m
    WHERE m.status = 'active'
      AND m.id NOT IN (
        SELECT match_id FROM predictions WHERE user_telegram_id = ?
      )
    ORDER BY m.kickoff_time ASC
  `, [telegramId]);
}

// ─── Predicted matches (active matches user already predicted) ────────────────

export function getPredictedMatches(telegramId: number) {
  return all(`
    SELECT m.*, p.predicted_home_score, p.predicted_away_score
    FROM matches m
    JOIN predictions p ON p.match_id = m.id AND p.user_telegram_id = ?
    WHERE m.status = 'active'
    ORDER BY m.kickoff_time ASC
  `, [telegramId]);
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

export function getLeaderboard(limit = 20) {
  return all(`
    SELECT u.telegram_id, u.username, u.first_name, u.total_points,
           COUNT(p.id) AS prediction_count
    FROM users u
    JOIN predictions p ON p.user_telegram_id = u.telegram_id
    GROUP BY u.telegram_id
    HAVING prediction_count > 0
    ORDER BY u.total_points DESC
    LIMIT ?
  `, [limit]);
}

// ─── Admin: clear all scores and predictions ──────────────────────────────────

export function clearAllScoresAndPredictions(): { usersReset: number; predictionsDeleted: number } {
  let usersReset = 0;
  let predictionsDeleted = 0;

  transaction(() => {
    predictionsDeleted = run(`DELETE FROM predictions`);
    usersReset = run(`UPDATE users SET total_points = 0`);
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
        SELECT user_telegram_id, points_awarded
        FROM predictions
        WHERE match_id = ? AND points_awarded IS NOT NULL
      `, [matchId]);

      for (const pred of predictions) {
        run(`UPDATE users SET total_points = MAX(0, total_points - ?) WHERE telegram_id = ?`,
          [pred.points_awarded, pred.user_telegram_id]);
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
