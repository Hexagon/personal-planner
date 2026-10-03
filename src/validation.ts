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
    case "update_asset":
      clean = {
        description: text(data.description),
        value_minor: integer(data.value_minor, 0, 1e12),
        notes: notes(data.notes),
      };
      break;
    case "add_task":
    case "update_task": {
      const status = data.status ?? "open";
      if (!["open", "done", "cancelled"].includes(String(status))) {
        throw new InputError("Invalid status");
      }
      clean = {
        description: text(data.description),
        location: location(data.location),
        base_priority: integer(data.base_priority ?? 3, 1, 5),
        estimated_cost_minor: optionalInteger(
          data.estimated_cost_minor,
          0,
          1e12,
        ),
        duration_minutes: optionalInteger(data.duration_minutes, 1, 1440),
        deadline: deadline(data.deadline),
        status,
      };
      break;
    }
    case "delete_asset":
    case "delete_task":
    case "delete_reminder":
      clean = { id: uuid(data.id) };
      break;
    case "set_profile": {
      const currency = text(data.currency, 3);
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new InputError("Use a three-letter currency code");
      }
      clean = {
        timezone: timezone(data.timezone),
        currency,
        starting_location: location(data.starting_location),
        preferences: notes(data.preferences),
        budget_minor: optionalInteger(data.budget_minor, 0, 1e12),
      };
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
  if (op.startsWith("update_")) clean.id = uuid(data.id);
  return { op, data: clean };
}
