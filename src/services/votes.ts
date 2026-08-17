import type { Participant } from "../types.js";
export class VoteBook {
  private votes = new Map<string, Set<number>>();
  cast(kind: string, playerId: number, players: Participant[]) {
    const set = this.votes.get(kind) ?? new Set<number>(); set.add(playerId); this.votes.set(kind, set);
    const required = Math.max(1, Math.ceil(players.length / 2));
    return { passed: set.size >= required, count: set.size, required };
  }
  clear() { this.votes.clear(); }
}
