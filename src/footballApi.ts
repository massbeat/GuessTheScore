import axios from 'axios';

// football-data.org API v4
// Docs: https://www.football-data.org/documentation/quickstart
// Auth: free API token from https://www.football-data.org/client/register

const BASE_URL = 'https://api.football-data.org/v4';

const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY!,
  },
});

export interface ApiCompetition {
  id: number;
  name: string;
  code: string;
  area: string;
  plan: string; // TIER_ONE, TIER_TWO, TIER_THREE, TIER_FOUR
  currentMatchday: number | null;
}

export interface ApiFixture {
  id: number;
  home_team: string;
  away_team: string;
  league: string;
  kickoff_time: string;
  home_score: number | null;
  away_score: number | null;
  status: string;
  matchday: number | null;
}

// List all available competitions (free tier = TIER_ONE + some TIER_TWO)
export async function fetchCompetitions(): Promise<ApiCompetition[]> {
  try {
    const response = await apiClient.get('/competitions');
    const competitions: any[] = response.data?.competitions ?? [];

    return competitions.map((c: any) => ({
      id: c.id,
      name: c.name,
      code: c.code ?? String(c.id),
      area: c.area?.name ?? 'Unknown',
      plan: c.plan ?? 'TIER_FOUR',
      currentMatchday: c.currentSeason?.currentMatchday ?? null,
    }));
  } catch (err: any) {
    console.error('fetchCompetitions error:', err.response?.data ?? err.message);
    throw new Error(err.response?.data?.message ?? err.message);
  }
}

// Fetch upcoming/scheduled matches for a competition
// Uses matchday if provided, otherwise fetches next scheduled matches
export async function fetchFixturesByCompetition(
  competitionCode: string,
  matchday?: number
): Promise<ApiFixture[]> {
  try {
    const params: Record<string, any> = { status: 'SCHEDULED' };
    if (matchday) params.matchday = matchday;

    const response = await apiClient.get(`/competitions/${competitionCode}/matches`, { params });
    const matches: any[] = response.data?.matches ?? [];

    return matches.map((m: any) => normalizeMatch(m, competitionCode)).filter(Boolean) as ApiFixture[];
  } catch (err: any) {
    console.error('fetchFixturesByCompetition error:', err.response?.data ?? err.message);
    throw new Error(err.response?.data?.message ?? err.message);
  }
}

// Fetch a single match by ID (for final score)
export async function fetchMatchById(matchId: number): Promise<ApiFixture | null> {
  try {
    const response = await apiClient.get(`/matches/${matchId}`);
    const m = response.data;
    if (!m) return null;
    return normalizeMatch(m, m.competition?.code ?? '');
  } catch (err: any) {
    console.error('fetchMatchById error:', err.response?.data ?? err.message);
    throw new Error(err.response?.data?.message ?? err.message);
  }
}

function normalizeMatch(m: any, competitionCode: string): ApiFixture | null {
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

    if (!id || !kickoff) return null;

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
  } catch {
    return null;
  }
}
