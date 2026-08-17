# osu! AHR Bot

TypeScript referee bot for Bancho multiplayer lobbies. The bot account only sends `!mp make` and room commands; it does not occupy an active slot. Lobbies are created through the authenticated dashboard API, not through chat.

## Architecture

`src/adapters` isolates Bancho IRC and osu! API v2. `LobbyController` owns per-lobby queue rotation, votes, regulation enforcement, timer, commands, team-event setup, and result processing. Prisma persists players, lobbies, sessions, matches, and scores in SQLite. The Express dashboard creates and lists lobbies.

## Setup

1. Install Node 22+ and run `npm install`.
2. Copy `.env.example` to `.env`; fill in an osu! OAuth application client ID/secret, the dedicated Bancho bot account, the legacy osu! API key required by `bancho.js`, an administrator ID list (`ADMIN_OSU_IDS=123,456`), and a long dashboard token.
3. Generate and migrate the database: `npm run db:generate` then `npm run db:migrate`.
4. Run `npm run dev` (or `npm run build` followed by `npm start`).
5. Open `http://localhost:3000` for the local dashboard. Enter your dashboard token there to create lobbies, choose regulations before creation, open the multiplayer room, and close active lobbies.

The API remains available for automation, for example:

```sh
curl -X POST http://localhost:3000/lobbies -H "Authorization: Bearer YOUR_TOKEN" -H "Content-Type: application/json" -d '{"title":"AHR #1","password":"secret"}'
```

## Data model

`Player` stores ELO, wins, matches, current/longest streak, total playtime, and deny status. `Lobby` holds serialized regulations and enforced locks. `LobbyPlayer` records sessions. `Match` and `Score` retain each result and allow last/best-score queries. The complete relational schema is in `prisma/schema.prisma`.

## Commands

All requested player, host, administrator, information, and ranking command listeners are in `src/lobby-controller.ts`. `!skip`/`!start` use a simple-majority vote for non-hosts; the host executes them directly. ELO starts at 1000 and uses a K-factor of 32. Every completed game advances the host queue. Random team events use a descending greedy ELO-balancing split, then restore the configured Head-to-Head settings.

Administrators may reset the competitive leaderboard with `*resetelo confirm`. This resets ELO, wins, matches, and streaks for every player, but retains lobby and match history.

## Production notes

Use PostgreSQL by changing Prisma's provider and `DATABASE_URL`; run the bot behind TLS/reverse proxy, rotate the dashboard token, and add reconnect/re-hydration handling before public operation. Confirm the installed `bancho.js` event/member names against its version—the adapter intentionally contains the only library-specific surface.
