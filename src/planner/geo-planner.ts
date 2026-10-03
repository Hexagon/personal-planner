import type { RecordData } from "../validation.ts";

export function locationKey(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
    : "";
}

// Groups tasks by case-insensitive location name, keeping input order.
export function groupByLocation(
  tasks: RecordData[],
): { location: string | null; tasks: RecordData[] }[] {
  const groups = new Map<
    string,
    { location: string | null; tasks: RecordData[] }
  >();
  for (const task of tasks) {
    const key = locationKey(task.location_name);
    const group = groups.get(key) ??
      { location: key ? String(task.location_name) : null, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return [...groups.values()].toSorted((a, b) =>
    Number(a.location === null) - Number(b.location === null)
  );
}
export const geoRole =
  "Location grouping: group tasks by their saved location_name labels. Labels are plain text; there are no coordinates, routes, travel times, opening hours or business lookups. Never invent them.";
