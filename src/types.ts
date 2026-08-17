export type GameMode = "osu" | "taiko" | "fruits" | "mania";
export type TeamMode = 0 | 1 | 2 | 3;
export type ScoreMode = 0 | 1 | 2 | 3;

export interface Regulations {
  enabled: boolean; minStar?: number; maxStar?: number; minLength?: number; maxLength?: number;
  gameMode?: GameMode; allowConvert: boolean; freeMod: boolean; allowedStatuses?: string[];
  minBpm?: number; maxBpm?: number; minAr?: number; maxAr?: number; minHp?: number; maxHp?: number;
  minOd?: number; maxOd?: number; minCs?: number; maxCs?: number;
  minLastUpdatedYear?: number; maxLastUpdatedYear?: number;
}
export interface LobbyConfig {
  title: string; size?: number; password?: string; teamMode: TeamMode; scoreMode: ScoreMode;
  mods: string[]; regulations: Regulations; eventChance: number;
  locks: { size?: boolean; password?: boolean; mode?: boolean; mods?: boolean; title?: boolean };
}
export const DEFAULT_CONFIG: LobbyConfig = {
  title: "AHR lobby", teamMode: 0, scoreMode: 0, mods: [], eventChance: 0.08,
  regulations: { enabled: true, allowConvert: false, freeMod: true }, locks: {}
};
export interface MapInfo {
  id: number; version: string; stars: number; length: number; mode: GameMode; converted: boolean; status: string;
  bpm: number; ar: number; hp: number; od: number; cs: number; lastUpdated?: string; rankedDate?: string;
}
export interface Participant { id: number; username: string; }
