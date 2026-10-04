import {
  InputError,
  object,
  type RecordData,
  taskStatuses,
  text,
} from "../validation.ts";
import { groupByLocation, locationKey } from "./geo-planner.ts";
import { urgencies, type Urgency, urgency } from "./task-tracker.ts";

const listLimit = 300;

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function taskLine(task: RecordData, today: string): string {
  const due = typeof task.due_date === "string"
    ? `, due ${task.due_date}${
      task.status === "open" ? ` (${urgency(task.due_date, today)})` : ""
    }`
    : "";
  return `- ${String(task.name)} — ${
    String(task.short_description)
  } [priority ${task.priority}${due}]`;
}

// The model interprets intent; saved records determine membership and identity.
export function taskList(
  tasks: RecordData[],
  input: unknown,
  today: string,
): string {
  const query = object(input);
  if (
    Object.keys(query).some((field) =>
      !["status", "location_name", "urgency"].includes(field)
    )
  ) throw new InputError("Invalid task query field");
  const status = query.status ?? "open";
  if (typeof status !== "string" || !taskStatuses.includes(status as "open")) {
    throw new InputError("Invalid task status filter");
  }
  const location = query.location_name == null
    ? null
    : text(query.location_name, 100);
  const wanted = query.urgency == null ? null : query.urgency;
  if (
    wanted !== null &&
    (!Array.isArray(wanted) || wanted.length < 1 ||
      wanted.length > urgencies.length ||
      !wanted.every((value) => urgencies.includes(value as Urgency)))
  ) {
    throw new InputError("Invalid urgency filter");
  }
  const selectedUrgencies = wanted as Urgency[] | null;
  const matching = tasks.filter((task) =>
    task.status === status &&
    (!location ||
      locationKey(task.location_name) === locationKey(location)) &&
    (!selectedUrgencies ||
      selectedUrgencies.includes(urgency(task.due_date, today)))
  );
  const shown = matching.slice(0, listLimit);
  const filters = [
    location ? `at ${location}` : null,
    selectedUrgencies ? `urgency ${selectedUrgencies.join("/")}` : null,
  ].filter(Boolean).join(", ");
  const heading = `${status[0].toUpperCase()}${status.slice(1)} tasks${
    filters ? ` (${filters})` : ""
  }: ${matching.length}${
    matching.length > shown.length ? `, first ${shown.length} shown` : ""
  }`;
  if (!shown.length) return `${heading}\nNone.`;
  if (location) {
    return `${heading}\n${
      shown.map((task) => taskLine(task, today)).join("\n")
    }`;
  }
  return [
    heading,
    ...groupByLocation(shown).map((group) =>
      `${group.location ?? "No location"}:\n${
        group.tasks.map((task) => taskLine(task, today)).join("\n")
      }`
    ),
  ].join("\n\n");
}

type Resolution = { ids: string[]; clarification: null } | {
  ids: null;
  clarification: string;
};

// Resolves user references by ID or whole-word name match; never guesses.
export function resolveReferences(
  tasks: RecordData[],
  references: string[],
  entity: "task" | "reminder" = "task",
): Resolution {
  const ids: string[] = [];
  for (const reference of references) {
    const phrase = normalized(reference);
    const candidates = tasks.filter((task) =>
      String(task.id).toLowerCase() === reference.toLowerCase() ||
      (phrase && ` ${normalized(String(task.name))} `.includes(` ${phrase} `))
    );
    const exact = candidates.filter((task) =>
      String(task.id).toLowerCase() === reference.toLowerCase() ||
      normalized(String(task.name)) === phrase
    );
    const matches = exact.length === 1 ? exact : candidates;
    if (matches.length !== 1) {
      return {
        ids: null,
        clarification: matches.length
          ? `Which ${entity} do you mean by "${reference}"? ${
            matches.slice(0, 5).map((task) =>
              `${String(task.name)} — ${
                String(task.short_description)
              } [${task.id}]`
            ).join("; ")
          }. Please give the full name or ID. Nothing has been changed.`
          : `I couldn't find one ${entity} matching "${reference}". Please give its full name or ID. Nothing has been changed.`,
      };
    }
    const id = String(matches[0].id);
    if (ids.includes(id)) {
      return {
        ids: null,
        clarification:
          `Several references match the same ${entity}. Please list each ${entity} once. Nothing has been changed.`,
      };
    }
    ids.push(id);
  }
  return { ids, clarification: null };
}

export function resolveCompletion(
  tasks: RecordData[],
  input: unknown,
): Resolution {
  const data = object(input);
  if (
    !Array.isArray(data.items) || data.items.length < 1 ||
    data.items.length > 20
  ) {
    throw new InputError("Complete between 1 and 20 task references");
  }
  return resolveReferences(
    tasks.filter((task) => task.status === "open"),
    data.items.map((item) => text(item, 1000)),
  );
}

export const detailPrefix = "Task details (not sent to the AI):";

export function taskDetail(task: RecordData, today: string): string {
  return [
    detailPrefix,
    taskLine(task, today).slice(2),
    `Status: ${task.status}${
      task.location_name ? `; location: ${task.location_name}` : ""
    }; created ${String(task.created_at ?? "").slice(0, 10)}`,
    task.full_description
      ? `Full description:\n${String(task.full_description)}`
      : "No full description saved.",
  ].join("\n");
}
