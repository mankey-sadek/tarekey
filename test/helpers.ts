import type { LatLng } from "../src/shared/geo.js";
export function offsetMeters(p: LatLng, dx: number, dy: number): LatLng {
  return { lat: p.lat + dy / 111_320, lng: p.lng + dx / (111_320 * Math.cos((p.lat * Math.PI) / 180)) };
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
