"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
exports.initDatabase = initDatabase;
exports.upsertUser = upsertUser;
exports.getUser = getUser;
exports.upsertMatch = upsertMatch;
exports.activateMatch = activateMatch;
exports.deactivateMatch = deactivateMatch;
exports.getMatch = getMatch;
exports.getActiveMatches = getActiveMatches;
exports.getPendingMatches = getPendingMatches;
exports.setMatchResult = setMatchResult;
exports.upsertPrediction = upsertPrediction;
exports.getPredictionsForMatch = getPredictionsForMatch;
exports.getUserPredictions = getUserPredictions;
exports.awardPoints = awardPoints;
exports.getUnpredictedMatches = getUnpredictedMatches;
exports.getPredictedMatches = getPredictedMatches;
exports.getLeaderboard = getLeaderboard;
exports.clearAllScoresAndPredictions = clearAllScoresAndPredictions;
exports.deactivateAllMatches = deactivateAllMatches;
exports.getFinishedMatches = getFinishedMatches;
exports.resetFinishedMatches = resetFinishedMatches;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const dbPath = process.env.DB_PATH || './data/predictions.db';
// Ensure directory exists
const dbDir = path_1.default.dirname(dbPath);
if (!fs_1.default.existsSync(dbDir)) {
    fs_1.default.mkdirSync(dbDir, { recursive: true });
}
exports.db = new better_sqlite3_1.default(dbPath);
function initDatabase() {
    exports.db.exec(`
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
    console.log('✅ Database initialized');
}
// ─── User queries ────────────────────────────────────────────────────────────
function upsertUser(telegramId, username, firstName) {
    exports.db.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `).run(telegramId, username ?? null, firstName);
}
function getUser(telegramId) {
    return exports.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}
// ─── Match queries ────────────────────────────────────────────────────────────
function upsertMatch(match) {
    exports.db.prepare(`
    INSERT INTO matches (id, home_team, away_team, league, kickoff_time)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      home_team = excluded.home_team,
      away_team = excluded.away_team,
      league = excluded.league,
      kickoff_time = excluded.kickoff_time
  `).run(match.id, match.home_team, match.away_team, match.league, match.kickoff_time);
}
function activateMatch(matchId) {
    exports.db.prepare(`UPDATE matches SET status = 'active' WHERE id = ?`).run(matchId);
}
function deactivateMatch(matchId) {
    exports.db.prepare(`UPDATE matches SET status = 'pending' WHERE id = ?`).run(matchId);
}
function getMatch(matchId) {
    return exports.db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
}
function getActiveMatches() {
    return exports.db.prepare(`SELECT * FROM matches WHERE status = 'active' ORDER BY kickoff_time ASC`).all();
}
function getPendingMatches() {
    return exports.db.prepare(`SELECT * FROM matches WHERE status = 'pending' ORDER BY kickoff_time ASC`).all();
}
function setMatchResult(matchId, homeScore, awayScore) {
    exports.db.prepare(`
    UPDATE matches SET status = 'finished', actual_home_score = ?, actual_away_score = ? WHERE id = ?
  `).run(homeScore, awayScore, matchId);
}
// ─── Prediction queries ───────────────────────────────────────────────────────
function upsertPrediction(telegramId, matchId, homeScore, awayScore) {
    // Prevent updating predictions for finished matches or those already scored
    const existing = exports.db.prepare(`
    SELECT p.points_awarded, m.status
    FROM predictions p
    JOIN matches m ON p.match_id = m.id
    WHERE p.user_telegram_id = ? AND p.match_id = ?
  `).get(telegramId, matchId);
    if (existing && (existing.status === 'finished' || existing.points_awarded !== null)) {
        return false; // Cannot update an already-scored prediction
    }
    exports.db.prepare(`
    INSERT INTO predictions (user_telegram_id, match_id, predicted_home_score, predicted_away_score, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id, match_id) DO UPDATE SET
      predicted_home_score = excluded.predicted_home_score,
      predicted_away_score = excluded.predicted_away_score,
      updated_at = CURRENT_TIMESTAMP
  `).run(telegramId, matchId, homeScore, awayScore);
    return true;
}
function getPredictionsForMatch(matchId) {
    return exports.db.prepare(`
    SELECT p.*, u.username, u.first_name
    FROM predictions p
    JOIN users u ON p.user_telegram_id = u.telegram_id
    WHERE p.match_id = ?
  `).all(matchId);
}
function getUserPredictions(telegramId) {
    return exports.db.prepare(`
    SELECT p.*, m.home_team, m.away_team, m.kickoff_time, m.actual_home_score, m.actual_away_score, m.status
    FROM predictions p
    JOIN matches m ON p.match_id = m.id
    WHERE p.user_telegram_id = ?
    ORDER BY m.kickoff_time DESC
    LIMIT 20
  `).all(telegramId);
}
function awardPoints(predictionId, points, telegramId) {
    const updatePrediction = exports.db.prepare(`UPDATE predictions SET points_awarded = ? WHERE id = ?`);
    const updateUser = exports.db.prepare(`UPDATE users SET total_points = total_points + ? WHERE telegram_id = ?`);
    const transaction = exports.db.transaction(() => {
        updatePrediction.run(points, predictionId);
        updateUser.run(points, telegramId);
    });
    transaction();
}
// ─── Unpredicted matches ─────────────────────────────────────────────────────
function getUnpredictedMatches(telegramId) {
    return exports.db.prepare(`
    SELECT m.*
    FROM matches m
    WHERE m.status = 'active'
      AND m.id NOT IN (
        SELECT match_id FROM predictions WHERE user_telegram_id = ?
      )
    ORDER BY m.kickoff_time ASC
  `).all(telegramId);
}
// ─── Predicted matches (active matches user already predicted) ───────────────
function getPredictedMatches(telegramId) {
    return exports.db.prepare(`
    SELECT m.*, p.predicted_home_score, p.predicted_away_score
    FROM matches m
    JOIN predictions p ON p.match_id = m.id AND p.user_telegram_id = ?
    WHERE m.status = 'active'
    ORDER BY m.kickoff_time ASC
  `).all(telegramId);
}
// ─── Leaderboard ──────────────────────────────────────────────────────────────
function getLeaderboard(limit = 20) {
    return exports.db.prepare(`
    SELECT u.telegram_id, u.username, u.first_name, u.total_points,
           COUNT(p.id) AS prediction_count
    FROM users u
    JOIN predictions p ON p.user_telegram_id = u.telegram_id
    GROUP BY u.telegram_id
    HAVING prediction_count > 0
    ORDER BY u.total_points DESC
    LIMIT ?
  `).all(limit);
}
// ─── Admin: clear all scores and predictions ─────────────────────────────────
function clearAllScoresAndPredictions() {
    const clearPredictions = exports.db.prepare(`DELETE FROM predictions`);
    const resetUsers = exports.db.prepare(`UPDATE users SET total_points = 0`);
    let usersReset = 0;
    let predictionsDeleted = 0;
    const transaction = exports.db.transaction(() => {
        const predResult = clearPredictions.run();
        predictionsDeleted = predResult.changes;
        const userResult = resetUsers.run();
        usersReset = userResult.changes;
    });
    transaction();
    return { usersReset, predictionsDeleted };
}
// ─── Admin: deactivate all active matches ────────────────────────────────────
function deactivateAllMatches() {
    const result = exports.db.prepare(`UPDATE matches SET status = 'pending' WHERE status = 'active'`).run();
    return result.changes;
}
// ─── Admin: get finished matches ─────────────────────────────────────────────
function getFinishedMatches() {
    return exports.db.prepare(`SELECT * FROM matches WHERE status = 'finished' ORDER BY kickoff_time DESC`).all();
}
// ─── Admin: reset finished matches back to pending ───────────────────────────
function resetFinishedMatches() {
    const finishedMatches = exports.db.prepare(`SELECT id FROM matches WHERE status = 'finished'`).all();
    const matchIds = finishedMatches.map((m) => m.id);
    if (matchIds.length === 0)
        return { matchesReset: 0, predictionsCleared: 0, pointsDeducted: 0 };
    let matchesReset = 0;
    let predictionsCleared = 0;
    let pointsDeducted = 0;
    const transaction = exports.db.transaction(() => {
        // For each finished match, deduct awarded points from users and remove predictions
        for (const matchId of matchIds) {
            const predictions = exports.db.prepare(`
        SELECT user_telegram_id, points_awarded
        FROM predictions
        WHERE match_id = ? AND points_awarded IS NOT NULL
      `).all(matchId);
            for (const pred of predictions) {
                exports.db.prepare(`UPDATE users SET total_points = MAX(0, total_points - ?) WHERE telegram_id = ?`)
                    .run(pred.points_awarded, pred.user_telegram_id);
                pointsDeducted += pred.points_awarded;
            }
            const delResult = exports.db.prepare(`DELETE FROM predictions WHERE match_id = ?`).run(matchId);
            predictionsCleared += delResult.changes;
        }
        // Reset matches to pending and clear scores
        const resetResult = exports.db.prepare(`
      UPDATE matches SET status = 'pending', actual_home_score = NULL, actual_away_score = NULL
      WHERE status = 'finished'
    `).run();
        matchesReset = resetResult.changes;
    });
    transaction();
    return { matchesReset, predictionsCleared, pointsDeducted };
}
