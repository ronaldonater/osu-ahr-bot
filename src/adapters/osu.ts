import type { GameMode, MapInfo } from "../types.js";

export class OsuApiRequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class OsuApi {
  private token?: string; private expiresAt = 0;
  constructor(private clientId: string, private clientSecret: string) {}
  private async accessToken() {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: "client_credentials", scope: "public" });
    const response = await fetch("https://osu.ppy.sh/oauth/token", { method: "POST", body });
    if (!response.ok) throw new Error("osu! OAuth failed");
    const json = await response.json() as { access_token: string; expires_in: number };
    this.token = json.access_token; this.expiresAt = Date.now() + (json.expires_in - 60) * 1000; return this.token;
  }
  async beatmap(id: number): Promise<MapInfo> {
    const response = await fetch(`https://osu.ppy.sh/api/v2/beatmaps/${id}`, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    if (!response.ok) throw new OsuApiRequestError(response.status, `osu! API beatmap request failed (${response.status})`);
    const b = await response.json() as any;
    return { id: b.id, version: b.version, stars: b.difficulty_rating, length: b.total_length, mode: b.mode as GameMode, converted: Boolean(b.convert), status: String(b.status ?? "unknown").toLowerCase() };
  }
  async user(username: string) {
    const response = await fetch(`https://osu.ppy.sh/api/v2/users/${encodeURIComponent(username)}/osu`, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    if (!response.ok) throw new Error("osu! user lookup failed"); return response.json() as Promise<any>;
  }
  async userBeatmapBestScore(beatmapId: number, userId: number) {
    const response = await fetch(`https://osu.ppy.sh/api/v2/beatmaps/${beatmapId}/scores/users/${userId}?legacy_only=0`, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`osu! score lookup failed (${response.status})`);
    return response.json() as Promise<{ position?: number; score: { score?: number; total_score?: number; legacy_total_score?: number; accuracy?: number; pp?: number; created_at?: string; mods?: Array<string | { acronym?: string }> } }>;
  }
}
