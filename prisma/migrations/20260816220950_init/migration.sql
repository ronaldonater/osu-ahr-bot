-- CreateTable
CREATE TABLE "Player" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "elo" INTEGER NOT NULL DEFAULT 1000,
    "matches" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "playSeconds" INTEGER NOT NULL DEFAULT 0,
    "denied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Lobby" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "banchoId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "password" TEXT,
    "config" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LobbyPlayer" (
    "lobbyId" INTEGER NOT NULL,
    "playerId" INTEGER NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionStart" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("lobbyId", "playerId"),
    CONSTRAINT "LobbyPlayer_lobbyId_fkey" FOREIGN KEY ("lobbyId") REFERENCES "Lobby" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LobbyPlayer_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Match" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "lobbyId" INTEGER NOT NULL,
    "beatmapId" INTEGER,
    "teamEvent" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    CONSTRAINT "Match_lobbyId_fkey" FOREIGN KEY ("lobbyId") REFERENCES "Lobby" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Score" (
    "matchId" INTEGER NOT NULL,
    "playerId" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "placement" INTEGER NOT NULL,
    "team" TEXT,
    "winner" BOOLEAN NOT NULL,

    PRIMARY KEY ("matchId", "playerId"),
    CONSTRAINT "Score_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Score_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Lobby_banchoId_key" ON "Lobby"("banchoId");
