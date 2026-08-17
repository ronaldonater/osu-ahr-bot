import Banchojs from "bancho.js";
import type { Participant } from "../types.js";

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
  onFreeModChanged(listener: (enabled: boolean) => void): void;
  onHostChanged(listener: (host: Participant) => void): void;
  onAllPlayersReady(listener: () => void): void;
  onModsChanged(listener: (mods: string[]) => void): void;
  onMatchStarted(listener: () => void): void;
  onMatchFinished(listener: (scores: Array<{ player: Participant; score: number; team?: "red" | "blue" }>) => void): void;
}
export class BanchoGateway {
  private client: any;
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
    await channel.sendMessage(password ? `!mp password ${password}` : "!mp password");
    return new BanchoRoom(channel);
  }
}
class BanchoRoom implements RoomActions {
  constructor(private channel: any) {}
  say(message: string) { return this.channel.sendMessage(message); }
  command(command: string) { return this.channel.sendMessage(command); }
  // Bancho's acknowledgement is not consistently emitted for client-created
  // tournament rooms, so send the command without waiting for that event.
  setTitle(title: string) { return this.channel.sendMessage(`!mp name ${title}`); }
  players(): Participant[] { return (this.channel.lobby?.slots ?? []).filter((s: any) => s?.user).map((s: any) => ({ id: s.user.id, username: s.user.ircUsername })); }
  host() { const h = this.channel.lobby?.getHost?.(); return h ? { id: h.user.id, username: h.user.ircUsername } : undefined; }
  beatmapId() { return this.channel.lobby?.beatmapId; }
  id() { return this.channel.lobby.id; }
  onMessage(listener: (sender: Participant, text: string) => void) { this.channel.on("message", (m: any) => listener({ id: m.user.id, username: m.user.ircUsername }, m.message)); }
  onPlayerJoined(listener: (player: Participant) => void) { this.channel.lobby.on("playerJoined", (e: any) => listener({ id: e.player.user.id, username: e.player.user.ircUsername })); }
  onPlayerLeft(listener: (player: Participant) => void) { this.channel.lobby.on("playerLeft", (player: any) => listener({ id: player.user.id, username: player.user.ircUsername })); }
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
  onFreeModChanged(listener: (enabled: boolean) => void) { this.channel.lobby.on("freemod", listener); }
  onHostChanged(listener: (host: Participant) => void) { this.channel.lobby.on("host", (player: any) => listener({ id: player.user.id, username: player.user.ircUsername })); }
  onAllPlayersReady(listener: () => void) { this.channel.lobby.on("allPlayersReady", listener); }
  onModsChanged(listener: (mods: string[]) => void) { this.channel.lobby.on("mods", (mods: any[]) => listener(mods.filter(Boolean).map(mod => mod.shortMod).filter(Boolean))); }
  onMatchStarted(listener: () => void) { this.channel.lobby.on("matchStarted", listener); }
  onMatchFinished(listener: (scores: any[]) => void) { this.channel.lobby.on("matchFinished", (scores: any[]) => listener(scores.map((s: any) => ({ player: { id: s.player.user.id, username: s.player.user.ircUsername }, score: s.score, team: s.player.team })))); }
}
