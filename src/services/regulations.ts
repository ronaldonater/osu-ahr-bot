import type { MapInfo, Regulations } from "../types.js";
export function checkMap(map: MapInfo, rule: Regulations): string | undefined {
  if (["deleted", "unsubmitted"].includes(map.status.toLowerCase())) return "unsubmitted or deleted maps are never allowed";
  if (!rule.enabled) return;
  if (rule.allowedStatuses?.length && !rule.allowedStatuses.includes(map.status.toLowerCase())) return `${map.status} maps are not allowed`;
  if (rule.minStar !== undefined && map.stars < rule.minStar) return `star rating ${map.stars} is below ${rule.minStar}`;
  if (rule.maxStar !== undefined && map.stars > rule.maxStar) return `star rating ${map.stars} exceeds ${rule.maxStar}`;
  if (rule.minLength !== undefined && map.length < rule.minLength) return `length ${map.length}s is below ${rule.minLength}s`;
  if (rule.maxLength !== undefined && map.length > rule.maxLength) return `length ${map.length}s exceeds ${rule.maxLength}s`;
  if (rule.gameMode && map.mode !== rule.gameMode) return `requires ${rule.gameMode} mode`;
  if (!rule.allowConvert && map.converted) return "map conversion is not allowed";
  const range = (label: string, value: number, min?: number, max?: number) => {
    if (min !== undefined && value < min) return `${label} ${value} is below ${min}`;
    if (max !== undefined && value > max) return `${label} ${value} exceeds ${max}`;
  };
  const dateYear = (label: string, value: string | undefined, min?: number, max?: number) => {
    if (min === undefined && max === undefined) return;
    const year = value ? new Date(value).getUTCFullYear() : NaN;
    if (!Number.isFinite(year)) return `${label} date is unavailable`;
    return range(`${label} year`, year, min, max);
  };
  const usesLastUpdated = ["graveyard", "pending", "wip"].includes(map.status.toLowerCase());
  const yearLabel = usesLastUpdated ? "last updated" : `${map.status} date`;
  const yearDate = usesLastUpdated ? map.lastUpdated : map.rankedDate;
  return range("BPM", map.bpm, rule.minBpm, rule.maxBpm)
    ?? range("AR", map.ar, rule.minAr, rule.maxAr)
    ?? range("HP", map.hp, rule.minHp, rule.maxHp)
    ?? range("OD", map.od, rule.minOd, rule.maxOd)
    ?? range("CS", map.cs, rule.minCs, rule.maxCs)
    ?? dateYear(yearLabel, yearDate, rule.minLastUpdatedYear, rule.maxLastUpdatedYear);
}
