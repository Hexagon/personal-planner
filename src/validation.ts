import { Cron } from "croner";

export class InputError extends Error {}
export type RecordData = Record<string, unknown>;
export interface Proposal {
  op: string;
  data: RecordData;
}
export function object(value: unknown): RecordData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("Expected an object");
  }
  return value as RecordData;
}
export function text(value: unknown, max = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new InputError(`Expected non-empty text (maximum ${max} characters)`);
  }
  return value.trim();
}
export function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
  ) {
    throw new InputError("Invalid record ID");
  }
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < min ||
    value > max
  ) {
    throw new InputError("Invalid integer amount or range");
  }
  return value;
}
function optionalInteger(
  value: unknown,
  min: number,
  max: number,
): number | null {
  return value == null ? null : integer(value, min, max);
}
function notes(value: unknown): string {
  return value == null || value === "" ? "" : text(value, 4000);
}
export function taskKind(value: unknown): string {
  if (value !== "task" && value !== "purchase") {
    throw new InputError("Invalid task kind");
  }
  return value;
}
export function destinations(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10) {
    throw new InputError("Use at most 10 destinations");
  }
  const labels = value.map((label) => text(label, 200));
  if (
    new Set(labels.map((label) => label.toLowerCase())).size !== labels.length
  ) {
    throw new InputError("Destinations must be unique");
  }
  return labels;
}
export function timezone(value: unknown): string {
  const zone = text(value, 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    throw new InputError("Invalid IANA timezone");
  }
  return zone;
}
export function location(value: unknown): RecordData | null {
  if (value == null) return null;
  const data = object(value);
  const result: RecordData = { label: text(data.label, 200) };
  if (data.latitude != null || data.longitude != null) {
    if (
      typeof data.latitude !== "number" || !Number.isFinite(data.latitude) ||
      Math.abs(data.latitude) > 90 || typeof data.longitude !== "number" ||
      !Number.isFinite(data.longitude) || Math.abs(data.longitude) > 180
    ) {
      throw new InputError("Invalid coordinates");
    }
    result.latitude = data.latitude;
    result.longitude = data.longitude;
  }
  return result;
}
export function nextOccurrence(
  cron: unknown,
  zone: unknown,
  after = new Date(),
): string {
  const pattern = text(cron, 100);
  if (pattern.split(/\s+/).length !== 5) {
    throw new InputError("Use a five-field cron expression");
  }
  try {
    const job = new Cron(pattern, { timezone: timezone(zone), paused: true });
    const next = job.nextRun(after);
    job.stop();
    if (!next) throw new Error("No future occurrence");
    return next.toISOString();
  } catch {
    throw new InputError("Invalid schedule or timezone");
  }
}
function deadline(value: unknown): string | null {
  if (value == null) return null;
  if (
    typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  ) {
    throw new InputError("Invalid deadline date");
  }
  return value;
}
// Return only known fields; never spread model input into a database write.
export function validateProposal(value: unknown, now = new Date()): Proposal {
  const proposal = object(value);
  const data = object(proposal.data);
  const op = text(proposal.op, 40);
  let clean: RecordData;
  switch (op) {
    case "add_asset":
    case "update_asset": {
      clean = {};
      if (op === "add_asset" || data.description !== undefined) {
        clean.description = text(data.description);
      }
      if (op === "add_asset" || data.value_minor !== undefined) {
        clean.value_minor = integer(data.value_minor, 0, 1e12);
      }
      if (op === "add_asset" || data.notes !== undefined) {
        clean.notes = notes(data.notes);
      }
      break;
    }
    case "add_task":
    case "update_task": {
      const status = data.status ?? "open";
      if (!["open", "done", "cancelled"].includes(String(status))) {
        throw new InputError("Invalid status");
      }
      clean = {};
      if (op === "add_task" || data.description !== undefined) {
        clean.description = text(data.description);
      }
      if (op === "add_task" || data.location !== undefined) {
        clean.location = location(data.location);
      }
      if (op === "add_task" || data.base_priority !== undefined) {
        clean.base_priority = integer(data.base_priority ?? 3, 1, 5);
      }
      if (op === "add_task" || data.estimated_cost_minor !== undefined) {
        clean.estimated_cost_minor = optionalInteger(
          data.estimated_cost_minor,
          0,
          1e12,
        );
      }
      if (op === "add_task" || data.duration_minutes !== undefined) {
        clean.duration_minutes = optionalInteger(
          data.duration_minutes,
          1,
          1440,
        );
      }
      if (op === "add_task" || data.deadline !== undefined) {
        clean.deadline = deadline(data.deadline);
      }
      if (op === "add_task" || data.status !== undefined) clean.status = status;
      if (op === "add_task" || data.kind !== undefined) {
        clean.kind = taskKind(data.kind === undefined ? "task" : data.kind);
      }
      if (op === "add_task" || data.category !== undefined) {
        clean.category = data.category == null
          ? null
          : text(data.category, 100);
      }
      if (op === "add_task" || data.destinations !== undefined) {
        clean.destinations = destinations(
          data.destinations === undefined ? [] : data.destinations,
        );
      }
      if (op === "add_task" || data.next_trip !== undefined) {
        if (
          data.next_trip !== undefined && typeof data.next_trip !== "boolean"
        ) {
          throw new InputError("Next trip must be a boolean");
        }
        clean.next_trip = data.next_trip ?? false;
      }
      break;
    }
    case "complete_tasks": {
      if (
        !Array.isArray(data.ids) || data.ids.length < 1 || data.ids.length > 20
      ) {
        throw new InputError("Complete between 1 and 20 tasks");
      }
      const ids = data.ids.map(uuid);
      if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
        throw new InputError("Task IDs must be unique");
      }
      clean = { ids };
      break;
    }
    case "delete_asset":
    case "delete_task":
    case "delete_reminder":
      clean = { id: uuid(data.id) };
      break;
    case "set_profile": {
      clean = {};
      if (data.timezone !== undefined) {
        clean.timezone = timezone(data.timezone);
      }
      if (data.currency !== undefined) {
        const currency = text(data.currency, 3);
        if (!/^[A-Z]{3}$/.test(currency)) {
          throw new InputError("Use a three-letter currency code");
        }
        clean.currency = currency;
      }
      if (data.starting_location !== undefined) {
        clean.starting_location = location(data.starting_location);
      }
      if (data.preferences !== undefined) {
        clean.preferences = notes(data.preferences);
      }
      if (data.budget_minor !== undefined) {
        clean.budget_minor = optionalInteger(data.budget_minor, 0, 1e12);
      }
      break;
    }
    case "add_reminder":
      clean = {
        description: text(data.description),
        cron: text(data.cron, 100),
        timezone: timezone(data.timezone),
        next_run: nextOccurrence(data.cron, data.timezone, now),
      };
      break;
    default:
      throw new InputError("Unsupported action");
  }
  if (op.startsWith("update_") && Object.keys(clean).length === 0) {
    throw new InputError("Update must include a changed field");
  }
  if (op === "set_profile" && Object.keys(clean).length === 0) {
    throw new InputError("Profile update must include a changed field");
  }
  if (op.startsWith("update_")) clean.id = uuid(data.id);
  return { op, data: clean };
}
