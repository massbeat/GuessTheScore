/**
 * Scoring Algorithm
 *
 * 3 pts - Exact score
 * 2 pts - Correct goal difference (includes draws)
 * 1 pt  - Correct outcome (win/draw/loss) but wrong difference
 * 0 pts - Wrong outcome
 */
export function calculatePoints(
  predictedHome: number,
  predictedAway: number,
  actualHome: number,
  actualAway: number
): number {
  // 3 points: exact score
  if (predictedHome === actualHome && predictedAway === actualAway) {
    return 3;
  }

  const predictedDiff = predictedHome - predictedAway;
  const actualDiff = actualHome - actualAway;

  // 2 points: correct goal difference (covers draws like 0-0 vs 1-1)
  if (predictedDiff === actualDiff) {
    return 2;
  }

  // 1 point: correct outcome (home win / draw / away win)
  const predictedOutcome = Math.sign(predictedDiff);
  const actualOutcome = Math.sign(actualDiff);

  if (predictedOutcome === actualOutcome) {
    return 1;
  }

  return 0;
}

export function pointsLabel(points: number): string {
  switch (points) {
    case 3: return '🎯 Exact score!';
    case 2: return '✅ Correct difference';
    case 1: return '👍 Correct outcome';
    default: return '❌ Wrong outcome';
  }
}
