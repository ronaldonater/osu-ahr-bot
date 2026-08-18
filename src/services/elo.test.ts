import assert from "node:assert/strict";
import test from "node:test";
import { fractionalElo } from "./elo.js";

test("fractional ELO averages tied ranks and groups aborts in last place", () => {
  const results = fractionalElo([
    { playerId: 1, currentElo: 1200, matchCount: 4, score: 1_000_000 },
    { playerId: 2, currentElo: 1200, matchCount: 4, score: 1_000_000 },
    { playerId: 3, currentElo: 1000, matchCount: 11, score: 900_000 },
    { playerId: 4, currentElo: 800, matchCount: 101, score: null }
  ]);
  assert.equal(results[0].rank, 1.5);
  assert.equal(results[1].rank, 1.5);
  assert.equal(results[3].rank, 4);
  assert.equal(results[0].kFactor, 40);
  assert.equal(results[2].kFactor, 24);
  assert.equal(results[3].kFactor, 16);
  assert.equal(results[0].eloChange, results[1].eloChange);
  assert.ok(results[3].eloChange < 0);
});
