import type { Participant } from "../types.js";
export function balancedTeams(players: Array<Participant & { elo: number }>) {
  const red: typeof players = [], blue: typeof players = [];
  let redTotal = 0, blueTotal = 0;
  for (const player of [...players].sort((a, b) => b.elo - a.elo)) {
    if (redTotal <= blueTotal) { red.push(player); redTotal += player.elo; }
    else { blue.push(player); blueTotal += player.elo; }
  }
  return { red, blue };
}
