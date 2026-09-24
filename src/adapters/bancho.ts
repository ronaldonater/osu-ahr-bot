import Banchojs from "bancho.js";
import type { Participant } from "../types.js";

export interface RoomActivity { at: string; level: "info" | "error"; message: string; }

/** Narrow, testable boundary around bancho.js. The bot account is referee-only; it never joins a slot. */
export interface RoomActions {
  say(message: string): Promise<void>; command(command: string): Promise<void>;
  setTitle(title: string): Promise<void>;
  players(): Participant[]; host(): Participant | undefined; beatmapId(): number | undefined;
  id(): number;
  onMessage(listener: (sender: Participant, text: string) => void): void;
  onPlayerJoined(listener: (player: Participant) => void): void;
  onPlayerLeft(listener: (player: Participant) => void): void;
  onBeatmapChanged(listener: (beatmapId: number) => void): void;
  onTitleChanged(listener: (title: string) => void): void;
  onPasswordChanged(listener: () => void): void;
  onHostChanged(listener: (host?: Participant) => void): void;
  onAllPlayersReady(listener: () => void): void;
  onMatchStarted(listener: () => void): void;
  onMatchFinished(listener: (scores: Array<{ player: Participant; score: number; team?: "red" | "blue" }>) => void): void;
  onActivity(listener: (activity: RoomActivity) => void): void;
}
/** Shared across every lobby because Bancho's message cap applies to the bot account, not an individual room. */
class BanchoRateLimiter {
  private timestamps: number[] = [];
  private queue = Promise.resolve();
  send(action: () => Promise<void>) {
    const task = this.queue.then(async () => {
      for (;;) {
        const now = Date.now();
        this.timestamps = this.timestamps.filter(timestamp => now - timestamp < 5_000);
        if (this.timestamps.length < 10) break;
        const wait = 5_000 - (now - this.timestamps[0]) + 10;
        await new Promise(resolve => setTimeout(resolve, wait));
      }
      this.timestamps.push(Date.now());
      await action();
    });
    // A rejected send must not block subsequent queued messages forever.
    this.queue = task.catch(() => undefined);
    return task;
  }
}
export class BanchoGateway {
  private client: any;
  private readonly limiter = new BanchoRateLimiter();
  constructor(username: string, password: string, apiKey: string) {
    // bancho.js is CommonJS: its default export is a namespace object whose
    // BanchoClient property is the constructor.
    this.client = new (Banchojs as any).BanchoClient({ username, password, apiKey, botAccount: true });
  }
  async connect() { await this.client.connect(); }
  async makeLobby(name: string, password?: string): Promise<RoomActions> {
    const channel = await this.client.createLobby(name);
    // Tournament lobbies created by `!mp make` are password-protected by
    // default. Sending the command without an argument removes that password.
    await this.limiter.send(() => channel.sendMessage(password ? `!mp password ${password}` : "!mp password"));
    return new BanchoRoom(channel, this.limiter);
  }
}
class BanchoRoom implements RoomActions {
  private readonly activityListeners = new Set<(activity: RoomActivity) => void>();
  constructor(private channel: any, private limiter: BanchoRateLimiter) {}
  private activity(level: RoomActivity["level"], message: string) { const entry = { at: new Date().toISOString(), level, message }; for (const listener of this.activityListeners) listener(entry); }
  private participant(user: any, source: string): Participant | undefined {
    if (!user || !Number.isInteger(user.id) || !user.ircUsername) { this.activity("error", `${source}: Bancho sent an incomplete player payload.`); return; }
    return { id: user.id, username: user.ircUsername };
  }
  private send(message: string, label: string) { return this.limiter.send(() => this.channel.sendMessage(message)).then(() => this.activity("info", `${label}: ${message}`), error => { this.activity("error", `${label} failed: ${error instanceof Error ? error.message : String(error)}`); throw error; }); }
  say(message: string) { return this.send(message, "Chat"); }
  command(command: string) { return this.send(command, "Command"); }
  // Bancho's acknowledgement is not consistently emitted for client-created
  // tournament rooms, so send the command without waiting for that event.
  setTitle(title: string) { return this.send(`!mp name ${title}`, "Command"); }
  players(): Participant[] { return (this.channel.lobby?.slots ?? []).filter((s: any) => s?.user).map((s: any) => ({ id: s.user.id, username: s.user.ircUsername })); }
  host() { const h = this.channel.lobby?.getHost?.(); return h?.user ? { id: h.user.id, username: h.user.ircUsername } : undefined; }
  beatmapId() { return this.channel.lobby?.beatmapId; }
  id() { return this.channel.lobby.id; }
  onMessage(listener: (sender: Participant, text: string) => void) { this.channel.on("message", (m: any) => { const player = this.participant(m?.user, "Chat message"); if (player) listener(player, m.message); }); }
  onPlayerJoined(listener: (player: Participant) => void) { this.channel.lobby.on("playerJoined", (e: any) => { const player = this.participant(e?.player?.user, "Player join"); if (player) listener(player); }); }
  onPlayerLeft(listener: (player: Participant) => void) { this.channel.lobby.on("playerLeft", (player: any) => { const participant = this.participant(player?.user, "Player leave"); if (participant) listener(participant); }); }
  onBeatmapChanged(listener: (beatmapId: number) => void) { this.channel.lobby.on("beatmapId", listener); }
  onTitleChanged(listener: (title: string) => void) {
    this.channel.lobby.on("name", listener);
    // Some client-originated renames only arrive as a BanchoBot channel message.
    this.channel.on("message", (message: any) => {
      if (message.user?.ircUsername?.toLowerCase() !== "banchobot") return;
      const match = /^Room name updated to "(.+)"$/i.exec(message.message);
      if (match) listener(match[1]);
    });
  }
  onPasswordChanged(listener: () => void) { this.channel.lobby.on("passwordChanged", listener); this.channel.lobby.on("passwordRemoved", listener); }
  onHostChanged(listener: (host?: Participant) => void) { this.channel.lobby.on("host", (player: any) => listener(player?.user ? this.participant(player.user, "Host change") : undefined)); }
  onAllPlayersReady(listener: () => void) { this.channel.lobby.on("allPlayersReady", listener); }
  onMatchStarted(listener: () => void) { this.channel.lobby.on("matchStarted", listener); }
  onMatchFinished(listener: (scores: any[]) => void) { this.channel.lobby.on("matchFinished", (scores: any[]) => listener(scores.flatMap((score: any) => { const player = this.participant(score?.player?.user, "Match result"); return player ? [{ player, score: score.score, team: score.player.team }] : []; }))); }
  onActivity(listener: (activity: RoomActivity) => void) { this.activityListeners.add(listener); }
}
