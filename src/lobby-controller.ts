import { PrismaClient } from "@prisma/client";
import type { RoomActions } from "./adapters/bancho.js";
import { OsuApiRequestError, type OsuApi } from "./adapters/osu.js";
import { DEFAULT_CONFIG, gameModeLabel, type GameMode, type LobbyConfig, type Participant } from "./types.js";
import { checkMap } from "./services/regulations.js";
import { fractionalElo, winRate } from "./services/elo.js";
import { balancedTeams } from "./services/teams.js";
import { VoteBook } from "./services/votes.js";

const admins = new Set((process.env.ADMIN_OSU_IDS ?? "").split(",").filter(Boolean).map(Number));
const fmt = (s: number) => `${Math.floor(s / 60)}m ${s % 60}s`;
const fmtSession = (s: number) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;

export class LobbyController {
  private config: LobbyConfig; private queue: number[] = []; private autoSkip = new Set<number>(); private votes = new VoteBook();
  private timer?: NodeJS.Timeout; private startedAt?: Date; private matchId?: number; private activeBeatmapId?: number; private matchGameMode?: GameMode; private selectedGameMode?: GameMode; private matchParticipants: Participant[] = []; private teamEvent = false; private eventActive = false; private lastValidMapId?: number; private passwordSetUntil = 0; private freeModSetUntil = 0;
  private turnTimer?: NodeJS.Timeout; private turnWarnings: NodeJS.Timeout[] = []; private turnHostId?: number; private turnMapId?: number; private turnStage?: "select" | "start";
  constructor(private db: PrismaClient, private lobbyId: number, private room: RoomActions, private osu: OsuApi, config: LobbyConfig = DEFAULT_CONFIG) { this.config = config; }
  async start() {
    this.room.onMessage((p, t) => void this.handle(p, t));
    this.room.onPlayerJoined(() => void this.joined());
    this.room.onPlayerLeft(player => void this.departed(player));
    this.room.onBeatmapChanged(id => void this.validateSelection(id));
    this.room.onTitleChanged(title => void this.enforceTitle(title));
    this.room.onPasswordChanged(() => void this.enforcePassword());
    this.room.onFreeModChanged(enabled => void this.enforceFreeMod(enabled));
    this.room.onHostChanged(host => void this.hostChanged(host));
    this.room.onAllPlayersReady(() => void this.allPlayersReady());
    this.room.onModsChanged(mods => void this.enforceDefaultMods(mods));
    this.room.onMatchStarted(() => void this.beginMatch());
    this.room.onMatchFinished(s => void this.finish(s));
    this.reapplyFreeMod();
    await this.joined();
    this.hostChanged(this.room.host());
    if (this.room.beatmapId()) await this.validateSelection(this.room.beatmapId()!);
  }
  private async joined() { await this.syncPlayers(); await this.electHost(); }
  private async departed(player: Participant) {
    const wasQueued = this.queue.includes(player.id);
    this.queue = this.queue.filter(id => id !== player.id);
    this.autoSkip.delete(player.id);
    const session = await this.db.lobbyPlayer.findUnique({ where: { lobbyId_playerId: { lobbyId: this.lobbyId, playerId: player.id } } });
    if (session) {
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - session.sessionStart.getTime()) / 1000));
      await this.db.$transaction([
        this.db.player.update({ where: { id: player.id }, data: { playSeconds: { increment: elapsedSeconds } } }),
        this.db.lobbyPlayer.delete({ where: { lobbyId_playerId: { lobbyId: this.lobbyId, playerId: player.id } } })
      ]);
    }
    if (wasQueued) await this.room.say(`${player.username} left and was removed from the queue.`);
    // Bancho clears host state asynchronously after a host leaves.
    setTimeout(() => { void this.disableSoloAutoSkip(); void this.electHost(); }, 250);
  }
  private async syncPlayers() {
    const players = this.room.players();
    for (const p of players) {
      const saved = await this.db.player.upsert({ where: { id: p.id }, create: { id: p.id, username: p.username }, update: { username: p.username } });
      if (!saved.denied && !this.queue.includes(p.id)) this.queue.push(p.id);
      await this.db.lobbyPlayer.upsert({ where: { lobbyId_playerId: { lobbyId: this.lobbyId, playerId: p.id } }, create: { lobbyId: this.lobbyId, playerId: p.id }, update: {} });
    }
  }
  private isHost(p: Participant) { return this.room.host()?.id === p.id; }
  private async electHost() {
    if (this.room.host() || !this.queue[0]) return;
    await this.room.command(`!mp host #${this.queue[0]}`);
    this.reapplyTitle(); this.reapplyPassword(); this.reapplyFreeMod();
    await this.room.say(`Host assigned to the first queued player.`);
  }
  private hostChanged(host?: Participant) {
    if (!host || this.matchId || host.id === this.turnHostId) return;
    this.turnHostId = host.id;
    if (this.autoSkip.has(host.id)) {
      if (this.room.players().length <= 1) {
        this.autoSkip.delete(host.id);
        void this.room.say(`${host.username}: auto-skip disabled because this is now a one-player lobby.`);
        this.startTurnTimer("select", host);
        return;
      }
      void this.room.say(`${host.username}'s host turn was automatically skipped.`).then(() => this.skip());
      return;
    }
    this.startTurnTimer("select", host);
  }
  private clearTurnTimer() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    for (const warning of this.turnWarnings) clearTimeout(warning);
    this.turnTimer = undefined; this.turnWarnings = []; this.turnMapId = undefined; this.turnStage = undefined;
  }
  private startTurnTimer(stage: "select" | "start", host: Participant, mapId?: number) {
    this.clearTurnTimer(); this.turnHostId = host.id; this.turnMapId = mapId; this.turnStage = stage;
    const action = stage === "select" ? "select a map" : "start the match";
    if (stage === "select") void this.room.say(`${host.username}, you have 5 minutes to select a map or host will be passed to the next player.`);
    for (const [delay, remaining] of [[180_000, "2 minutes"], [240_000, "1 minute"], [270_000, "30 seconds"], [290_000, "10 seconds"]] as const) {
      this.turnWarnings.push(setTimeout(() => void this.room.say(`${host.username}: ${remaining} left to ${action}.`), delay));
    }
    this.turnTimer = setTimeout(() => void this.turnExpired(stage, host, mapId), 300_000);
  }
  private async turnExpired(stage: "select" | "start", host: Participant, mapId?: number) {
    if (this.room.host()?.id !== host.id || this.matchId) return;
    this.clearTurnTimer();
    if (stage === "select") { await this.room.say(`${host.username} ran out of time to select a map. Host passed.`); await this.skip(); }
    else { await this.room.say(`${host.username} ran out of time to start. Starting automatically.`); await this.startMatch(0); }
  }
  private async allPlayersReady() {
    if (!this.room.beatmapId() || this.matchId) return;
    this.clearTurnTimer();
    await this.room.say("All players are ready. Starting automatically in 5 seconds.");
    await this.startMatch(5);
  }
  private mapSelected(mapId: number) {
    const host = this.room.host();
    if (!host || this.matchId || (this.turnStage === "start" && this.turnHostId === host.id && this.turnMapId === mapId)) return;
    this.startTurnTimer("start", host, mapId);
  }
  private async handle(p: Participant, raw: string) {
    if (!raw.startsWith("!") && !raw.startsWith("*")) return;
    await this.syncPlayers(); const [rawCommand, ...args] = raw.trim().split(/\s+/); const cmd = rawCommand.toLowerCase(); const value = args.join(" ");
    if (cmd.startsWith("*") && !admins.has(p.id)) return void this.room.say(`${p.username}: administrator permission required.`);
    if (cmd === "!queue") return void this.showQueue();
    if (cmd === "!cmds") return void this.room.say("Command list: https://ronaldonater.com/osu-ahr");
    if (cmd === "!bug") return void this.room.say("Report a bug: https://github.com/ronaldonater/osu-ahr-bot/issues");
    if (["!regulations"].includes(cmd)) return void this.showRegulations();
    if (["!version", "!v"].includes(cmd)) return void this.room.say("osu-ahr-bot v0.1.9");
    if (["!playtime", "!pt"].includes(cmd)) return void this.playtime(p, value || undefined);
    if (["!timeleft", "!tl"].includes(cmd)) return void this.timeleft();
    if (["!ostats", "!os"].includes(cmd)) { const { username, mode } = this.usernameAndMode(args); return void this.stats(p, username, mode); }
    if (["!top", "!t"].includes(cmd)) return void this.top(args);
    if (["!how", "!h"].includes(cmd)) return void this.room.say("Ranked H2H uses fractional ELO: placement earns results, exact ties share rank, and disconnects tie last. K is 40 for 0–10 matches, 24 for 11–100, then 16. Results adjust against the lobby's average ELO. Random events are unranked.");
    if (cmd === "!rank") { const { username, mode } = this.usernameAndMode(args); return void this.rank(p, username, mode); }
    if (["!lastscore", "!ls"].includes(cmd)) return void this.lastScore();
    if (["!bestscore", "!bs"].includes(cmd)) return void this.bestScore(p, value || undefined);
    if (cmd === "!autoskip") return void this.setAutoSkip(p, args[0]);
    if (cmd === "!update") return void (this.isHost(p) ? this.updateMap() : this.room.say(`${p.username}: only the current host can use !update.`));
    if (cmd === "!skip") return void (this.isHost(p) ? this.skip() : this.vote("skip", p));
    if (cmd === "!start") return void (this.isHost(p) ? this.startMatch(Number(args[0] ?? 5)) : this.vote("start", p));
    if (cmd === "!abort") return void this.vote("abort", p);
    if (cmd === "!stop" && this.isHost(p)) return void this.stopTimer();
    if (cmd === "*start") return void this.startMatch(0);
    if (cmd === "*skip") return void this.skip();
    if (cmd === "*abort") return void this.abortMatch();
    if (cmd === "*order") return void this.order(value);
    if (cmd === "*resetelo") return void this.resetElo(args[0]);
    if (cmd === "*close") return void this.closeLobby();
    if (cmd === "*eventchance") return void this.setEventChance(args[0]);
    if (cmd === "*keep") return void this.keep(args);
    if (cmd === "*no" && args[0] === "keep") return void this.noKeep(args[1]);
    if (cmd === "*regulation" || cmd === "*no" && args[0] === "regulation") return void this.regulation(cmd === "*no" ? ["disable"] : args);
    if (cmd === "*denylist") return void this.denylist(args);
  }
  private async vote(kind: string, p: Participant) { const r = this.votes.cast(kind, p.id, this.room.players()); await this.room.say(`${kind}: ${r.count}/${r.required}`); if (r.passed) { this.votes.clear(); if (kind === "skip") await this.skip(); if (kind === "start") await this.startMatch(5); if (kind === "abort") await this.abortMatch(); } }
  private async abortMatch() { await this.room.command("!mp abort"); await this.room.say("Match aborted."); }
  private async showQueue() { const rows = await this.db.player.findMany({ where: { id: { in: this.queue } } }); await this.room.say(`Queue: ${this.queue.map((id, i) => `${i + 1}. ${rows.find(x => x.id === id)?.username ?? id}`).join(" | ") || "empty"}`); }
  private async setAutoSkip(p: Participant, value?: string) {
    const enabled = value?.toLowerCase();
    if (enabled !== "on" && enabled !== "off") return void this.room.say("Usage: !autoskip [on/off].");
    if (enabled === "on") {
      if (this.room.players().length <= 1) return void this.room.say(`${p.username}: auto-skip cannot be enabled in a one-player lobby.`);
      this.autoSkip.add(p.id);
      await this.room.say(`${p.username}: auto-skip enabled. Your host turns will be passed automatically.`);
      if (this.isHost(p) && !this.matchId) await this.skip();
    } else {
      this.autoSkip.delete(p.id);
      await this.room.say(`${p.username}: auto-skip disabled.`);
    }
  }
  private async disableSoloAutoSkip() {
    const players = this.room.players();
    if (players.length !== 1) return;
    const player = players[0];
    if (this.autoSkip.delete(player.id)) await this.room.say(`${player.username}: auto-skip disabled because this is now a one-player lobby.`);
  }
  private async showRegulations() {
    await this.room.say(this.regulationSummary());
  }
  private regulationSummary() {
    const r = this.config.regulations;
    if (!r.enabled) return "Map regulations are currently disabled.";
    const stars = r.minStar !== undefined || r.maxStar !== undefined ? `${r.minStar?.toFixed(2) ?? "any"}–${r.maxStar?.toFixed(2) ?? "any"}★` : "any star rating";
    const length = r.minLength !== undefined || r.maxLength !== undefined ? `${r.minLength !== undefined ? fmt(r.minLength) : "any"}–${r.maxLength !== undefined ? fmt(r.maxLength) : "any"}` : "any length";
    const mode = r.gameMode ? r.gameMode[0].toUpperCase() + r.gameMode.slice(1) : "any mode";
    const statuses = r.allowedStatuses?.length ? r.allowedStatuses.join(", ") : "all statuses";
    const range = (min: number | undefined, max: number | undefined, suffix = "") => min !== undefined || max !== undefined ? `${min ?? "any"}–${max ?? "any"}${suffix}` : "any";
    return `Map regulations — Stars: ${stars} | Length: ${length} | BPM: ${range(r.minBpm, r.maxBpm)} | AR: ${range(r.minAr, r.maxAr)} | HP: ${range(r.minHp, r.maxHp)} | OD: ${range(r.minOd, r.maxOd)} | CS: ${range(r.minCs, r.maxCs)} | Year: ${range(r.minLastUpdatedYear, r.maxLastUpdatedYear)} | Mode: ${mode} | Status: ${statuses} | Converts: ${r.allowConvert ? "allowed" : "not allowed"} | Free mod: ${r.freeMod ? "enabled" : "disabled"}.`;
  }
  private async skip() { if (this.queue.length) this.queue.push(this.queue.shift()!); const next = this.queue[0]; this.turnHostId = undefined; if (next) await this.room.command(`!mp host #${next}`); this.reapplyTitle(); this.reapplyPassword(); this.reapplyFreeMod(); setTimeout(() => this.hostChanged(this.room.host()), 500); await this.showQueue(); }
  private async startMatch(seconds: number) { if (!Number.isFinite(seconds) || seconds < 0 || seconds > 120) return void this.room.say("Start delay must be between 0 and 120 seconds."); const mapId = this.room.beatmapId(); if (!mapId) return void this.room.say("Select a beatmap first."); const reason = checkMap(await this.osu.beatmap(mapId), this.config.regulations); if (reason) return void this.room.say(`Map rejected: ${reason}.`); this.clearTurnTimer(); this.stopTimer(); this.timer = setTimeout(() => void this.launch(mapId), seconds * 1000); await this.room.say(`Match starts in ${seconds}s.`); }
  private async validateSelection(mapId: number) {
    // Bancho emits an intermediate empty/invalid map ID while a host changes maps.
    // Wait for the subsequent real beatmap ID instead of showing an error to chat.
    if (!Number.isInteger(mapId) || mapId <= 0) return;
    try {
      const map = await this.osu.beatmap(mapId);
      const reason = checkMap(map, this.config.regulations);
      if (!reason) { this.lastValidMapId = mapId; this.selectedGameMode = map.mode; this.mapSelected(mapId); return; }
      if (this.lastValidMapId) {
        await this.room.command(`!mp map ${this.lastValidMapId}`);
        await this.room.say(`Map rejected: ${reason}. Reverted to the previous valid map.`);
      } else await this.room.say(`Map rejected: ${reason}. Select a regulation-compliant map.`);
    } catch (error) {
      if (error instanceof OsuApiRequestError && error.status === 404 && this.lastValidMapId) {
        await this.room.command(`!mp map ${this.lastValidMapId}`);
        await this.room.say("Map rejected: this map is unsubmitted or deleted. Reverted to the previous valid map.");
      }
      // API data may be briefly unavailable while Bancho changes the beatmap.
      // Do not spam the lobby; a later beatmap event will retry validation.
    } finally { this.reapplyTitle(); this.reapplyPassword(); }
  }
  private reapplyTitle() {
    if (!this.config.locks.title) return;
    void this.room.setTitle(this.config.title).catch(() => undefined);
  }
  private reapplyPassword() {
    if (!this.config.locks.password || !this.config.password) return;
    this.passwordSetUntil = Date.now() + 3_000;
    void this.room.command(`!mp password ${this.config.password}`).catch(() => undefined);
  }
  private reapplyFreeMod() {
    this.freeModSetUntil = Date.now() + 3_000;
    void this.room.command(this.config.regulations.freeMod ? "!mp mods 0 freemod" : "!mp mods 0").catch(() => undefined);
  }
  private async enforceTitle(title: string) {
    if (!this.config.locks.title || title === this.config.title) return;
    this.reapplyTitle();
    await this.room.say("Lobby title is locked and has been restored.");
  }
  private async enforcePassword() {
    if (!this.config.locks.password || !this.config.password || Date.now() < this.passwordSetUntil) return;
    this.reapplyPassword();
    await this.room.say("Lobby password is locked and has been restored.");
  }
  private async enforceFreeMod(enabled: boolean) {
    if (Date.now() < this.freeModSetUntil || enabled === this.config.regulations.freeMod) return;
    this.reapplyFreeMod();
    await this.room.say(`Free mod is regulated and has been restored to ${this.config.regulations.freeMod ? "enabled" : "disabled"}.`);
  }
  private async enforceDefaultMods(mods: string[]) {
    const blocked = mods.filter(mod => ["DT", "NC", "HT"].includes(mod.toUpperCase()));
    if (!blocked.length) return;
    this.reapplyFreeMod();
    await this.room.say(`${blocked.join("/")} is not allowed as a lobby modifier. Restored permitted mods.`);
  }
  private async launch(mapId: number) {
    const gameMode = (await this.osu.beatmap(mapId)).mode;
    this.eventActive = Math.random() < this.config.eventChance;
    this.teamEvent = false;
    if (this.eventActive) {
      const events: Array<{ teamMode: 0 | 2; scoreMode: 0 | 1 | 2; label: string }> = [
        { teamMode: 2, scoreMode: 0, label: "Team VS — Score" },
        { teamMode: 2, scoreMode: 2, label: "Team VS — Combo" },
        { teamMode: 2, scoreMode: 1, label: "Team VS — Accuracy" },
        { teamMode: 0, scoreMode: 2, label: "Head-to-Head — Combo" },
        { teamMode: 0, scoreMode: 1, label: "Head-to-Head — Accuracy" }
      ];
      const event = events[Math.floor(Math.random() * events.length)]; this.teamEvent = event.teamMode === 2;
      await this.room.command(`!mp set ${event.teamMode} ${event.scoreMode}`);
      if (this.teamEvent) {
        const ids = this.room.players().map(p => p.id);
        const players = await this.db.player.findMany({ where: { id: { in: ids } } });
        const modeStats = await this.db.playerModeStats.findMany({ where: { playerId: { in: ids }, mode: gameMode } });
        const eloByPlayer = new Map(modeStats.map(stat => [stat.playerId, stat.elo]));
        const teams = balancedTeams(players.map(player => ({ ...player, elo: eloByPlayer.get(player.id) ?? 1000 })));
        await this.room.command(`!mp team Red ${teams.red.map(player => player.username).join(",")}`);
        await this.room.command(`!mp team Blue ${teams.blue.map(player => player.username).join(",")}`);
        await this.room.say(`Random event: ${event.label} (unranked). Balanced teams assigned based on ELO.`);
      } else await this.room.say(`Random event: ${event.label} (unranked).`);
    }
    await this.beginMatch(mapId, gameMode); await this.room.command("!mp start"); }
  /** Covers bot-started games and games started directly by the current host. */
  private async beginMatch(mapId = this.room.beatmapId(), gameMode?: GameMode) {
    if (this.matchId) return;
    this.clearTurnTimer();
    // Keep a start-of-match roster so disconnects remain in the rating result.
    this.matchParticipants = this.room.players();
    this.matchGameMode = gameMode ?? this.selectedGameMode ?? this.config.regulations.gameMode ?? "osu";
    this.matchId = (await this.db.match.create({ data: { lobbyId: this.lobbyId, beatmapId: mapId, gameMode: this.matchGameMode, teamEvent: this.teamEvent, startedAt: new Date() } })).id;
    // Reapplying Free Mod with `!mp mods 0 freemod` clears every player's
    // individual selections. It is already enforced when the setting changes,
    // so never send that command as a match is beginning.
    this.activeBeatmapId = mapId; this.startedAt = new Date(); this.votes.clear(); this.reapplyTitle(); this.reapplyPassword();
  }
  private stopTimer() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private async announceEloChanges(mode: GameMode, changes: string[]) {
    if (!changes.length) return;
    const heading = `ELO changes (${gameModeLabel(mode)}): `;
    let message = heading;
    for (const change of changes) {
      const next = message === heading ? `${message}${change}` : `${message} | ${change}`;
      if (next.length > 400 && message !== heading) {
        await this.room.say(message);
        message = `${heading}${change}`;
      } else message = next;
    }
    await this.room.say(message);
  }
  private async finish(scores: Array<{ player: Participant; score: number; team?: "red" | "blue" }>) {
    if (!this.matchId) return;
    const matchId = this.matchId; const ordered = [...scores].sort((a, b) => b.score - a.score);
    const gameMode = this.matchGameMode ?? this.selectedGameMode ?? this.config.regulations.gameMode ?? "osu";
    const resultByPlayer = new Map(ordered.map(result => [result.player.id, result]));
    const participantById = new Map(this.matchParticipants.map(player => [player.id, player]));
    for (const result of ordered) participantById.set(result.player.id, result.player);
    const participants = [...participantById.values()];
    const savedStats = await this.db.playerModeStats.findMany({ where: { playerId: { in: participants.map(player => player.id) }, mode: gameMode } });
    const statsByPlayer = new Map(savedStats.map(stat => [stat.playerId, stat]));
    const ratingInputs = participants.flatMap(player => {
      const score = resultByPlayer.get(player.id)?.score;
      const stats = statsByPlayer.get(player.id);
      return [{ playerId: player.id, currentElo: stats?.elo ?? 1000, matchCount: stats?.matches ?? 0, score: score === undefined || score === null || score === -1 ? null : score }];
    });
    const ranked = !this.eventActive && ratingInputs.length > 1 ? fractionalElo(ratingInputs) : [];
    const ratingByPlayer = new Map(ranked.map(result => [result.playerId, result]));
    const highestCompletedScore = Math.max(...ratingInputs.map(result => result.score ?? -1));
    for (const player of participants) {
      const result = resultByPlayer.get(player.id); const rating = ratingByPlayer.get(player.id);
      const score = result?.score ?? -1; const winner = Boolean(rating && score >= 0 && score === highestCompletedScore);
      const saved = statsByPlayer.get(player.id);
      await this.db.$transaction([
        this.db.score.create({ data: { matchId, playerId: player.id, score, placement: rating ? Math.floor(rating.rank) : ordered.findIndex(entry => entry.player.id === player.id) + 1, team: result?.team, winner } }),
        ...(rating ? [this.db.playerModeStats.upsert({ where: { playerId_mode: { playerId: player.id, mode: gameMode } }, create: { playerId: player.id, mode: gameMode, elo: rating.newElo, matches: 1, wins: winner ? 1 : 0, streak: winner ? 1 : 0, longestStreak: winner ? 1 : 0 }, update: { elo: rating.newElo, matches: { increment: 1 }, wins: { increment: winner ? 1 : 0 }, streak: winner ? { increment: 1 } : 0, longestStreak: winner ? Math.max(saved?.longestStreak ?? 0, (saved?.streak ?? 0) + 1) : saved?.longestStreak ?? 0 } })] : [])
      ]);
    }
    if (ranked.length) {
      await this.announceEloChanges(gameMode, participants.flatMap(player => {
        const rating = ratingByPlayer.get(player.id);
        return rating ? [`${player.username} ${rating.eloChange >= 0 ? "+" : ""}${rating.eloChange} (${rating.newElo})`] : [];
      }));
    } else if (this.eventActive) await this.room.say("This random event was unranked; no ELO changes were applied.");
    else if (ratingInputs.length === 1) await this.room.say("No ELO changes were applied: at least two players are required for a ranked match.");
    await this.db.match.update({ where: { id: this.matchId }, data: { endedAt: new Date() } });
    const mapId = this.activeBeatmapId; const startedAt = this.startedAt; const leaderboardParticipants = ordered.map(x => ({ ...x.player, matchScore: x.score }));
    this.matchId = undefined; this.activeBeatmapId = undefined; this.matchGameMode = undefined; this.startedAt = undefined; this.matchParticipants = [];
    if (mapId && startedAt) setTimeout(() => void this.announceLeaderboardScores(mapId, startedAt, leaderboardParticipants), 10_000);
    if (this.eventActive) { await this.room.command(`!mp set ${this.config.teamMode} ${this.config.scoreMode}`); this.teamEvent = false; this.eventActive = false; }
    await this.skip(); }
  private async announceLeaderboardScores(mapId: number, startedAt: Date, players: Array<Participant & { matchScore: number }>) {
    // Newly-submitted scores can take longer than a few seconds to appear in
    // the public API. Retry for two minutes, while still requiring this exact
    // match score to be in the map's top 50.
    await Promise.all(players.map(player => this.announceLeaderboardScore(mapId, startedAt, player)));
  }
  private async announceLeaderboardScore(mapId: number, startedAt: Date, player: Participant & { matchScore: number }) {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const result = await this.osu.userBeatmapBestScore(mapId, player.id);
        const recordedAt = result?.score.created_at ? Date.parse(result.score.created_at) : NaN;
        const globalPosition = result ? await this.osu.leaderboardPosition(mapId, result.score.id) : undefined;
        // Ignore a player's existing leaderboard score: it must have been set in this match.
        if (!result || !globalPosition || globalPosition > 50 || !Number.isFinite(recordedAt) || recordedAt < startedAt.getTime() - 120_000) {
          if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 10_000));
          continue;
        }
        const score = result.score; const points = score.legacy_total_score || score.total_score || score.score || 0;
        if (points !== player.matchScore) {
          if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 10_000));
          continue;
        }
        const mods = (score.mods ?? []).map(m => typeof m === "string" ? m : m.acronym ?? "").filter(Boolean).join("") || "NM";
        const pp = score.pp == null ? "" : ` (${score.pp.toFixed(2)}pp)`;
        await this.room.say(`Congratulations ${player.username}! Your ${points.toLocaleString()} +${mods}${pp} score is now global #${globalPosition} on this map!`);
        return;
      } catch { /* A delayed leaderboard lookup should never disrupt lobby rotation. */ }
      if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 10_000));
    }
  }
  private async playtime(p: Participant, username?: string) {
    const player = username
      ? (await this.db.player.findMany({ where: { username: { contains: username } }, take: 10 })).find(candidate => candidate.username.toLowerCase() === username.toLowerCase())
      : await this.db.player.findUnique({ where: { id: p.id } });
    if (!player) return void this.room.say(`${username ?? p.username}: no local player record found.`);
    const session = await this.db.lobbyPlayer.findUnique({ where: { lobbyId_playerId: { lobbyId: this.lobbyId, playerId: player.id } } });
    if (!session) return void this.room.say(`${player.username}: no active session in this lobby.`);
    await this.room.say(`${player.username}: session ${fmtSession(Math.floor((Date.now() - session.sessionStart.getTime()) / 1000))}.`);
  }
  private async timeleft() { if (!this.startedAt || !this.room.beatmapId()) return void this.room.say("No active match."); const map = await this.osu.beatmap(this.room.beatmapId()!); await this.room.say(`About ${fmt(Math.max(0, map.length - Math.floor((Date.now() - this.startedAt.getTime()) / 1000)))} left.`); }
  private currentStatsMode() { return this.selectedGameMode ?? this.config.regulations.gameMode ?? "osu"; }
  private parseGameMode(value?: string): GameMode | undefined {
    const aliases: Record<string, GameMode> = { osu: "osu", std: "osu", standard: "osu", taiko: "taiko", fruits: "fruits", catch: "fruits", ctb: "fruits", mania: "mania" };
    return value ? aliases[value.toLowerCase()] : undefined;
  }
  private usernameAndMode(args: string[]) {
    const mode = this.parseGameMode(args.at(-1));
    const username = (mode ? args.slice(0, -1) : args).join(" ").trim() || undefined;
    return { username, mode };
  }
  private async stats(p: Participant, username?: string, requestedMode?: GameMode) {
    const player = username
      ? (await this.db.player.findMany({ where: { username: { contains: username } }, take: 10 })).find(candidate => candidate.username.toLowerCase() === username.toLowerCase())
      : await this.db.player.findUnique({ where: { id: p.id } });
    if (!player) return void this.room.say(`${username ?? p.username}: no local stats found.`);
    const mode = requestedMode ?? this.currentStatsMode();
    const stats = await this.db.playerModeStats.findUnique({ where: { playerId_mode: { playerId: player.id, mode } } });
    if (!stats) return void this.room.say(`${player.username}: no ${gameModeLabel(mode)} local stats found yet.`);
    await this.room.say(`${player.username} (${gameModeLabel(mode)}): ELO ${stats.elo}, LWS ${stats.longestStreak}, matches ${stats.matches}, win rate ${winRate(stats)}%.`);
  }
  private async top(args: string[]) {
    const local = args.some(arg => arg.toLowerCase() === "local");
    const modeArgs = args.filter(arg => arg.toLowerCase() !== "local");
    if (modeArgs.length > 1 || modeArgs.length === 1 && !this.parseGameMode(modeArgs[0])) return void this.room.say("Usage: !top [local] [osu|taiko|catch|mania].");
    const playerIds = this.room.players().map(player => player.id);
    const mode = this.parseGameMode(modeArgs[0]) ?? this.currentStatsMode();
    const players = await this.db.playerModeStats.findMany({ where: { mode, matches: { gte: 3 }, ...(local ? { playerId: { in: playerIds } } : {}) }, include: { player: true }, orderBy: [{ elo: "desc" }, { playerId: "asc" }], take: 10 });
    if (!players.length) return void this.room.say(local ? `No current lobby players have completed the 3 ${gameModeLabel(mode)} matches required for local rankings yet.` : `No players have completed the 3 ${gameModeLabel(mode)} matches required for local rankings yet.`);
    await this.room.say(`${local ? "Local top" : "Top"} (${gameModeLabel(mode)}): ${players.map((player, index) => `#${index + 1} ${player.player.username} (${player.elo})`).join(" | ")}`);
  }
  private async rank(p: Participant, username?: string, requestedMode?: GameMode) {
    const player = username
      ? (await this.db.player.findMany({ where: { username: { contains: username } }, take: 10 })).find(candidate => candidate.username.toLowerCase() === username.toLowerCase())
      : await this.db.player.findUnique({ where: { id: p.id } });
    if (!player) return void this.room.say(`${username ?? p.username}: no local ranking found.`);
    const mode = requestedMode ?? this.currentStatsMode();
    const stats = await this.db.playerModeStats.findUnique({ where: { playerId_mode: { playerId: player.id, mode } } });
    if (!stats || stats.matches < 3) return void this.room.say(`${player.username}: complete at least 3 ${gameModeLabel(mode)} matches to receive a local ranking.`);
    const eligible = { mode, matches: { gte: 3 } };
    const ahead = await this.db.playerModeStats.count({ where: { AND: [eligible, { OR: [{ elo: { gt: stats.elo } }, { elo: stats.elo, playerId: { lt: player.id } }] }] } });
    const total = await this.db.playerModeStats.count({ where: eligible });
    await this.room.say(`${player.username}: ${gameModeLabel(mode)} AHR rank #${ahead + 1} of ${total} (ELO ${stats.elo}).`);
  }
  private async lastScore() { const m = await this.db.match.findFirst({ where: { lobbyId: this.lobbyId, endedAt: { not: null } }, orderBy: { endedAt: "desc" }, include: { scores: { include: { player: true }, orderBy: { placement: "asc" } } } }); await this.room.say(m ? `Last: ${m.scores.map(s => `${s.placement}. ${s.player.username} ${s.score}`).join(" | ")}` : "No completed match."); }
  private async bestScore(p: Participant, username?: string) {
    const id = this.room.beatmapId(); if (!id) return void this.room.say("Select a beatmap first.");
    const map = await this.osu.beatmap(id);
    if (["wip", "pending", "graveyard"].includes(map.status)) return void this.room.say(`!bestscore is unavailable: ${map.status} maps do not have global leaderboards.`);
    let target = p;
    if (username) {
      try {
        const user = await this.osu.user(username);
        if (!Number.isInteger(user.id) || !user.username) return void this.room.say(`${username}: osu! user not found.`);
        target = { id: user.id, username: user.username };
      } catch { return void this.room.say(`${username}: osu! user not found.`); }
    }
    const result = await this.osu.userBeatmapBestScore(id, target.id);
    if (!result) return void this.room.say(`${target.username}: no submitted global score on this beatmap.`);
    const score = result.score;
    // Lazer scores use total_score; classic scores normally use legacy_total_score.
    // Some API responses include one of those as 0, so prefer the first non-zero value.
    const points = score.legacy_total_score || score.total_score || score.score || 0;
    const accuracy = score.accuracy === undefined ? "" : `, ${(score.accuracy * 100).toFixed(2)}%`;
    const pp = score.pp == null ? "" : `, ${score.pp.toFixed(2)}pp`;
    const modAcronyms = (score.mods ?? []).map(m => typeof m === "string" ? m : m.acronym ?? "").filter(Boolean);
    const mods = modAcronyms.length ? ` +${modAcronyms.join("")}` : " +NM";
    const globalPosition = await this.osu.leaderboardPosition(id, score.id);
    await this.room.say(`${target.username}: global best ${points.toLocaleString()}${accuracy}${pp}${mods}${globalPosition ? ` (global #${globalPosition})` : ""}.`);
  }
  private async order(value: string) { const names = value.split(",").map(x => x.trim().toLowerCase()); const players = await this.db.player.findMany({ where: { id: { in: this.queue } } }); this.queue = names.map(n => players.find(p => p.username.toLowerCase() === n)?.id).filter((x): x is number => x !== undefined); await this.showQueue(); }
  private async resetElo(confirmation?: string) {
    if (confirmation?.toLowerCase() !== "confirm") return void this.room.say("This resets every player's competitive stats. Use *resetelo confirm to proceed.");
    const result = await this.db.playerModeStats.updateMany({ data: { elo: 1000, matches: 0, wins: 0, streak: 0, longestStreak: 0 } });
    await this.room.say(`ELO rankings reset for ${result.count} player${result.count === 1 ? "" : "s"}.`);
  }
  private async closeLobby() {
    this.stopTimer(); this.clearTurnTimer();
    await this.room.say("This lobby is being closed by an administrator.");
    await this.room.command("!mp close");
  }
  private async setEventChance(value?: string) {
    const percent = Number(value);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return void this.room.say("Usage: *eventchance [0-100].");
    this.config.eventChance = percent / 100;
    await this.persist();
    await this.room.say(`Random event chance set to ${percent}%.`);
  }
  async close() { await this.closeLobby(); }
  async updateRegulations(regulations: Partial<LobbyConfig["regulations"]>, eventChance?: number, details?: { title?: string; password?: string; removePassword?: boolean }) {
    this.config.regulations = { ...DEFAULT_CONFIG.regulations, ...regulations };
    if (eventChance !== undefined) this.config.eventChance = eventChance;
    if (details?.title && details.title !== this.config.title) {
      this.config.title = details.title;
      await this.room.setTitle(details.title);
    }
    if (details?.removePassword || details?.password) {
      this.config.password = details.removePassword ? undefined : details.password;
      this.passwordSetUntil = Date.now() + 3_000;
      await this.room.command(this.config.password ? `!mp password ${this.config.password}` : "!mp password");
    }
    this.reapplyFreeMod();
    await this.db.lobby.update({ where: { id: this.lobbyId }, data: { name: this.config.title, password: this.config.password, config: this.config as any } });
    await this.room.say(`Lobby settings updated from the dashboard. ${this.regulationSummary()} Random events: ${(this.config.eventChance * 100).toFixed(0)}%.`);
  }
  private async updateMap() { const id = this.room.beatmapId(); if (!id) return void this.room.say("Select a beatmap first."); const map = await this.osu.beatmap(id); await this.room.command(`!mp map ${map.id}`); await this.room.say(`Map refreshed: ${map.version}.`); }
  private async keep(a: string[]) { const [kind, ...rest] = a; let confirmation = ""; if (kind === "size") { const size = Number(rest[0]); if (!Number.isInteger(size) || size < 1 || size > 16) return void this.room.say("Lobby size must be 1-16."); this.config.size = size; this.config.locks.size = true; await this.room.command(`!mp size ${this.config.size}`); confirmation = `Lobby size locked to ${size}.`; } if (kind === "password") { if (!this.config.password) return void this.room.say("This lobby was created passwordless, so password locking is not allowed."); const password = rest.join(" "); if (!password) return void this.room.say("Usage: *keep password [password]."); this.config.password = password; this.config.locks.password = true; this.passwordSetUntil = Date.now() + 3_000; await this.room.command(`!mp password ${this.config.password}`); confirmation = "Lobby password lock enabled."; } if (kind === "mode") { this.config.teamMode = Number(rest[0]) as 0; this.config.scoreMode = Number(rest[1]) as 0; this.config.locks.mode = true; await this.room.command(`!mp set ${this.config.teamMode} ${this.config.scoreMode}`); confirmation = "Lobby mode lock enabled."; } if (kind === "mods") { this.config.mods = rest; this.config.locks.mods = true; await this.room.command(`!mp mods ${rest.join(" ")}`); confirmation = `Mod lock enabled: ${rest.join(" ") || "None"}.`; } if (kind === "title") { const title = rest.join(" "); if (!title) return void this.room.say("Usage: *keep title [title]."); this.config.title = title; this.config.locks.title = true; await this.room.setTitle(this.config.title); confirmation = `Lobby title locked to: ${this.config.title}.`; } await this.persist(); if (confirmation) await this.room.say(confirmation); }
  private async noKeep(kind?: string) { if (kind === "mod") kind = "mods"; if (!kind || !["size", "password", "mode", "mods", "title"].includes(kind)) return void this.room.say("Unknown lobby lock. Use size, password, mode, mod, or title."); const wasLocked = Boolean(this.config.locks[kind as keyof LobbyConfig["locks"]]); delete this.config.locks[kind as keyof LobbyConfig["locks"]]; await this.persist(); await this.room.say(wasLocked ? `${kind === "mods" ? "Mod" : kind[0].toUpperCase() + kind.slice(1)} lock removed.` : `${kind === "mods" ? "Mod" : kind[0].toUpperCase() + kind.slice(1)} lock was not enabled.`); }
  private async regulation(a: string[]) {
    if (a[0] === "enable") this.config.regulations.enabled = true;
    else if (a[0] === "disable") this.config.regulations.enabled = false;
    else if (a[0] === "status") {
      const aliases: Record<string, string> = { graveyarded: "graveyard", pending: "pending", qualified: "qualified", ranked: "ranked", approved: "approved", loved: "loved", wip: "wip" };
      const statuses = a.slice(1).map(x => aliases[x.toLowerCase()] ?? x.toLowerCase()).filter(Boolean);
      if (!statuses.length) return void this.room.say("Usage: *regulation status all | ranked loved qualified pending graveyard wip.");
      this.config.regulations.allowedStatuses = statuses.includes("all") ? undefined : [...new Set(statuses)];
    } else {
      const pairs = a.length === 2 && !a[0].includes("=") ? [`${a[0]}=${a[1]}`] : a;
      for (const raw of pairs) {
        if (raw === "allow_convert") this.config.regulations.allowConvert = true;
        else if (raw === "disallow_convert") this.config.regulations.allowConvert = false;
        else if (raw === "freemod") this.config.regulations.freeMod = true;
        else if (raw === "no_freemod") this.config.regulations.freeMod = false;
        else {
          const [k, v] = raw.split("=");
          if (k === "gamemode" && ["osu", "taiko", "fruits", "mania"].includes(v)) this.config.regulations.gameMode = v as any;
          else if (["min_star", "max_star", "min_length", "max_length", "min_bpm", "max_bpm", "min_ar", "max_ar", "min_hp", "max_hp", "min_od", "max_od", "min_cs", "max_cs", "min_last_updated_year", "max_last_updated_year"].includes(k) && v && Number.isFinite(Number(v))) (this.config.regulations as any)[k.replace(/_([a-z])/g, (_, x) => x.toUpperCase())] = Number(v);
        }
      }
    }
    this.reapplyFreeMod(); await this.persist(); await this.room.say(`Regulations updated. ${this.regulationSummary()}`);
  }
  private async denylist(a: string[]) { const username = a.slice(1).join(" "); if (!["add", "remove"].includes(a[0]) || !username) return void this.room.say("Usage: *denylist add [username] or *denylist remove [username]."); const p = await this.db.player.findFirst({ where: { username: { equals: username } } }); if (!p) return void this.room.say(`${username} is not in this bot's player database yet.`); const denied = a[0] === "add"; await this.db.player.update({ where: { id: p.id }, data: { denied } }); await this.room.say(`${p.username} ${denied ? "added to" : "removed from"} the denylist.`); }
  private persist() { return this.db.lobby.update({ where: { id: this.lobbyId }, data: { config: this.config as any } }); }
}
