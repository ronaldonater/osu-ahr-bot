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
}
