import type { RecordData } from "../validation.ts";
export function distanceKm(a: RecordData, b: RecordData): number | null {
  if (
    ![a.latitude, a.longitude, b.latitude, b.longitude].every((n) =>
      typeof n === "number" && Number.isFinite(n)
    ) ||
    Math.abs(a.latitude as number) > 90 ||
    Math.abs(b.latitude as number) > 90 ||
    Math.abs(a.longitude as number) > 180 ||
    Math.abs(b.longitude as number) > 180
  ) return null;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const lat1 = radians(a.latitude as number),
    lat2 = radians(b.latitude as number);
  const dlat = lat2 - lat1,
    dlon = radians((b.longitude as number) - (a.longitude as number));
  const h = Math.sin(dlat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return Math.round(6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h))) * 10) / 10;
}
export function geographicContext(
  tasks: RecordData[],
  start: RecordData | null,
) {
  return tasks.map((task) => ({
    id: task.id,
    area: (task.location as RecordData | null)?.label ?? "Unknown",
    approximate_distance_km: start && task.location
      ? distanceKm(start, task.location as RecordData)
      : null,
  }));
}
export const geoRole =
  "Geographical planning: group nearby tasks using provided labels and deterministic straight-line distances. Respect priorities. Ask for available time and starting point. Unknown duration/location remains unknown; never invent traffic, opening hours, routes or businesses.";
