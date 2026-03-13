"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchCompetitions = fetchCompetitions;
exports.fetchFixturesByCompetition = fetchFixturesByCompetition;
exports.fetchMatchById = fetchMatchById;
const axios_1 = __importDefault(require("axios"));
// football-data.org API v4
// Docs: https://www.football-data.org/documentation/quickstart
// Auth: free API token from https://www.football-data.org/client/register
const BASE_URL = 'https://api.football-data.org/v4';
const apiClient = axios_1.default.create({
    baseURL: BASE_URL,
    headers: {
        'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY,
    },
});
// List all available competitions (free tier = TIER_ONE + some TIER_TWO)
async function fetchCompetitions() {
    try {
        const response = await apiClient.get('/competitions');
        const competitions = response.data?.competitions ?? [];
        return competitions.map((c) => ({
            id: c.id,
            name: c.name,
            code: c.code ?? String(c.id),
            area: c.area?.name ?? 'Unknown',
            plan: c.plan ?? 'TIER_FOUR',
            currentMatchday: c.currentSeason?.currentMatchday ?? null,
        }));
    }
    catch (err) {
        console.error('fetchCompetitions error:', err.response?.data ?? err.message);
        throw new Error(err.response?.data?.message ?? err.message);
    }
}
// Fetch upcoming/scheduled matches for a competition
// Uses matchday if provided, otherwise fetches next scheduled matches
async function fetchFixturesByCompetition(competitionCode, matchday) {
    try {
        const params = { status: 'SCHEDULED' };
        if (matchday)
            params.matchday = matchday;
        const response = await apiClient.get(`/competitions/${competitionCode}/matches`, { params });
        const matches = response.data?.matches ?? [];
        return matches.map((m) => normalizeMatch(m, competitionCode)).filter(Boolean);
    }
    catch (err) {
        console.error('fetchFixturesByCompetition error:', err.response?.data ?? err.message);
        throw new Error(err.response?.data?.message ?? err.message);
    }
}
// Fetch a single match by ID (for final score)
async function fetchMatchById(matchId) {
    try {
        const response = await apiClient.get(`/matches/${matchId}`);
        const m = response.data;
        if (!m)
            return null;
        return normalizeMatch(m, m.competition?.code ?? '');
    }
    catch (err) {
        console.error('fetchMatchById error:', err.response?.data ?? err.message);
        throw new Error(err.response?.data?.message ?? err.message);
    }
}
function normalizeMatch(m, competitionCode) {
    try {
        const id = m.id;
        const homeTeam = m.homeTeam?.shortName ?? m.homeTeam?.name ?? 'Unknown';
        const awayTeam = m.awayTeam?.shortName ?? m.awayTeam?.name ?? 'Unknown';
        const league = m.competition?.name
            ? `${m.competition.name} (${m.area?.name ?? competitionCode})`
            : competitionCode;
        const kickoff = m.utcDate;
        const homeScore = m.score?.fullTime?.home ?? null;
        const awayScore = m.score?.fullTime?.away ?? null;
        const status = m.status ?? 'SCHEDULED';
        const matchday = m.matchday ?? null;
        if (!id || !kickoff)
            return null;
        return {
            id: Number(id),
            home_team: String(homeTeam),
            away_team: String(awayTeam),
            league: String(league),
            kickoff_time: new Date(kickoff).toISOString(),
            home_score: homeScore !== null ? Number(homeScore) : null,
            away_score: awayScore !== null ? Number(awayScore) : null,
            status: String(status),
            matchday,
        };
    }
    catch {
        return null;
    }
}
