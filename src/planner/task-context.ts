import {
  InputError,
  location,
  object,
  type RecordData,
  taskKind,
  text,
  uuid,
} from "../validation.ts";
import { distanceKm } from "./geo-planner.ts";

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
function labelKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function destinationContext(query: RecordData, locate: typeof location) {
  const place = query.destination == null
    ? null
    : typeof query.destination === "string"
    ? { label: text(query.destination, 200) }
    : location(query.destination);
  const radius = query.radius_km == null ? null : query.radius_km;
  if (
    radius != null &&
    (typeof radius !== "number" || !Number.isFinite(radius) ||
      radius <= 0 || radius > 1000 || place?.latitude == null)
  ) {
    throw new InputError(
      "A radius must be greater than 0 and at most 1000 km, with destination coordinates",
    );
  }
  const grounded = locate(place);
  return {
    place: grounded,
    radius: grounded?.latitude == null ? null : radius as number | null,
  };
}

function matchesDestination(
  task: RecordData,
  place: RecordData,
  radius: number | null,
): boolean {
  const saved = task.location as RecordData | null;
  const distance = saved ? distanceKm(saved, place) : null;
  if (radius != null) return distance != null && distance <= radius;
  const labels = Array.isArray(task.destinations) ? task.destinations : [];
  return [...labels, saved?.label].some((label) =>
    typeof label === "string" &&
    labelKey(label) === labelKey(String(place.label))
  );
}

export function visitPlanContext(
  tasks: RecordData[],
  input: unknown,
  locate: typeof location = location,
) {
  const query = object(input);
  const { place, radius } = destinationContext(query, locate);
  if (!place) throw new InputError("A visit needs a destination");
  const ids = query.suggested_task_ids ?? [];
  if (!Array.isArray(ids) || ids.length > 100) {
    throw new InputError("Use at most 100 suggested tasks");
  }
  const suggestedIds = ids.map(uuid);
  if (
    new Set(suggestedIds.map((id) => id.toLowerCase())).size !==
      suggestedIds.length
  ) {
    throw new InputError("Suggested task IDs must be unique");
  }
  for (const id of suggestedIds) {
    if (
      !tasks.some((task) =>
        String(task.id).toLowerCase() === id.toLowerCase() &&
        task.status === "open"
      )
    ) {
      throw new InputError("Suggested task not found among your open tasks");
    }
  }
  const matched = tasks.filter((task) =>
    task.status === "open" && matchesDestination(task, place, radius)
  );
  const matchedIds = new Set(matched.map((task) => task.id));
  const suggested = tasks.filter((task) =>
    task.status === "open" && !matchedIds.has(task.id) &&
    suggestedIds.some((id) =>
      id.toLowerCase() === String(task.id).toLowerCase()
    )
  );
  const eligible = new Set([...matched, ...suggested].map((task) => task.id));
  const describe = (records: RecordData[]) =>
    records.slice(0, 20).map((task) => String(task.description).slice(0, 100))
      .join("; ") ||
    "None";
  return {
    tasks: tasks.filter((task) => eligible.has(task.id)),
    summary: `Visit context: ${place.label}${
      radius == null ? "" : `; radius ${radius} km (approximate straight-line)`
    }. Saved location matches: ${
      describe(matched)
    }. AI-suggested possibilities, not verified for this destination: ${
      describe(suggested)
    }. Stores, stock, opening hours and routes are not verified. Visit/travel time and cost are not included unless represented by a saved task with estimates; allow for them separately.`,
  };
}

// The model interprets intent; saved records determine membership and identity.
export function taskList(
  tasks: RecordData[],
  input: unknown,
  locate: typeof location = location,
): string {
  const query = object(input);
  const kind = query.kind == null ? null : taskKind(query.kind);
  const category = query.category == null ? null : text(query.category, 100);
  const { place, radius } = destinationContext(query, locate);
  const eligible = tasks.filter((task) =>
    task.status === "open" &&
    (!kind || (task.kind ?? "task") === kind) &&
    (!category ||
      labelKey(String(task.category ?? "")) === labelKey(category))
  );
  const matched: RecordData[] = [], uncertain: RecordData[] = [];
  for (const task of eligible) {
    const matches = place && matchesDestination(task, place, radius);
    (place && !matches ? uncertain : matched).push(task);
  }
  let remaining = 100;
  const section = (title: string, records: RecordData[]) => {
    const visible = records.slice(0, remaining);
    remaining -= visible.length;
    return `${title}\n${
      visible.map((task) =>
        `- ${String(task.description).slice(0, 100)}${
          task.next_trip ? " (next trip; no timed reminder)" : ""
        }`
      ).join("\n") ||
      (records.length ? "Additional items omitted (100-item limit)." : "None.")
    }`;
  };
  const heading = kind === "purchase" ? "Shopping list" : "Open tasks";
  if (!place) {
    return section(`${heading} (open only; at most 100 shown):`, matched);
  }
  return [
    `${heading} for ${place.label}${
      radius == null ? "" : ` within ${radius} km (approximate straight-line)`
    } (open only; at most 100 shown). Saved locations are not proof of store or stock availability.`,
    section("Saved destination matches:", matched),
    section("Destination not established; check before your trip:", uncertain),
    "I cannot verify stores, stock, or opening hours.",
  ].join("\n\n");
}

export function resolveCompletion(
  tasks: RecordData[],
  input: unknown,
): { ids: string[]; clarification: null } | {
  ids: null;
  clarification: string;
} {
  const data = object(input);
  if (
    !Array.isArray(data.items) || data.items.length < 1 ||
    data.items.length > 20
  ) {
    throw new InputError("Complete between 1 and 20 task references");
  }
  const references = data.items.map((item) => text(item, 1000));
  const ids: string[] = [];
  for (const reference of references) {
    const phrase = normalized(reference);
    const matches = tasks.filter((task) =>
      task.status === "open" &&
      (String(task.id).toLowerCase() === reference.toLowerCase() ||
        (phrase && ` ${normalized(String(task.description))} `.includes(
          ` ${phrase} `,
        )))
    );
    if (matches.length !== 1) {
      return {
        ids: null,
        clarification: matches.length
          ? `Which task do you mean by "${reference}"? ${
            matches.slice(0, 5).map((task) =>
              `${String(task.description).slice(0, 100)} [${task.id}]`
            ).join("; ")
          }. Please give the full description or ID. Nothing has been changed.`
          : `I couldn't find one open task matching "${reference}". Please give its full description or ID. Nothing has been changed.`,
      };
    }
    const id = String(matches[0].id);
    if (ids.includes(id)) {
      return {
        ids: null,
        clarification:
          "Several references match the same task. Please list each task once. Nothing has been changed.",
      };
    }
    ids.push(id);
  }
  return { ids, clarification: null };
}
