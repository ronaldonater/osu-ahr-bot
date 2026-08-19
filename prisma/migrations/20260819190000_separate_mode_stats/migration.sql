-- Keep all existing competitive data as osu!standard data, then store future
-- ELO and competitive statistics independently for each osu! ruleset.
ALTER TABLE "Match" ADD COLUMN "gameMode" TEXT NOT NULL DEFAULT 'osu';

CREATE TABLE "PlayerModeStats" (
    "playerId" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "elo" INTEGER NOT NULL DEFAULT 1000,
    "matches" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("playerId", "mode"),
    CONSTRAINT "PlayerModeStats_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "PlayerModeStats" ("playerId", "mode", "elo", "matches", "wins", "streak", "longestStreak", "createdAt", "updatedAt")
SELECT "id", 'osu', "elo", "matches", "wins", "streak", "longestStreak", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Player";

CREATE INDEX "PlayerModeStats_mode_elo_idx" ON "PlayerModeStats"("mode", "elo");
