import type { Player } from "@prisma/client";

export interface EloMatchPlayer {
  playerId: number;
  currentElo: number;
  matchCount: number;
  /** `null` and `-1` represent an aborted/disconnected result. */
  score: number | null;
}

export interface FractionalEloResult extends EloMatchPlayer {
  newElo: number;
  eloChange: number;
  rank: number;
  actualResult: number;
  expectedResult: number;
  kFactor: number;
}

export function kFactor(matchCount: number) {
  if (matchCount <= 10) return 40;
  if (matchCount <= 100) return 24;
  return 16;
}

export function expected(rating: number, lobbyAverage: number) {
  return 1 / (1 + 10 ** ((lobbyAverage - rating) / 400));
}

/** Fractional placement ELO with averaged tie ranks and tied-last aborts. */
export function fractionalElo(players: EloMatchPlayer[]): FractionalEloResult[] {
  if (!players.length) return [];
  const averageElo = players.reduce((total, player) => total + player.currentElo, 0) / players.length;
  const sorted = [...players].sort((a, b) => {
    const aAborted = a.score === null || a.score === -1;
    const bAborted = b.score === null || b.score === -1;
    if (aAborted && bAborted) return 0;
    if (aAborted) return 1;
    if (bAborted) return -1;
    return b.score! - a.score!;
  });
  const ranks = new Map<number, number>();
  for (let start = 0; start < sorted.length;) {
    const score = sorted[start].score;
    const aborted = score === null || score === -1;
    let end = start + 1;
    while (end < sorted.length) {
      const next = sorted[end].score;
      if ((next === null || next === -1) !== aborted || (!aborted && next !== score)) break;
      end++;
    }
    const rank = ((start + 1) + end) / 2;
    for (let index = start; index < end; index++) ranks.set(sorted[index].playerId, rank);
    start = end;
  }
  return players.map(player => {
    const rank = ranks.get(player.playerId)!;
    const actualResult = players.length === 1 ? 0 : (players.length - rank) / (players.length - 1);
    const expectedResult = expected(player.currentElo, averageElo);
    const factor = kFactor(player.matchCount);
    const newElo = players.length === 1 ? player.currentElo : Math.round(player.currentElo + factor * (actualResult - expectedResult));
    return { ...player, rank, actualResult, expectedResult, kFactor: factor, newElo, eloChange: newElo - player.currentElo };
  });
}

export function winRate(player: Pick<Player, "wins" | "matches">) {
  return player.matches ? ((player.wins / player.matches) * 100).toFixed(1) : "0.0";
}
