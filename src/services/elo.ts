import type { Player } from "@prisma/client";

const K = 32;
export function expected(a: number, b: number) { return 1 / (1 + 10 ** ((b - a) / 400)); }
export function newRating(rating: number, opponentAverage: number, result: 0 | 1) {
  return Math.round(rating + K * (result - expected(rating, opponentAverage)));
}
export function winRate(player: Pick<Player, "wins" | "matches">) {
  return player.matches ? ((player.wins / player.matches) * 100).toFixed(1) : "0.0";
}
