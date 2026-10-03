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
function optionalText(value: unknown, max: number): string | null {
  return value == null || value === "" ? null : text(value, max);
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
export const maxOpenTasks = 300;
export const taskStatuses = ["open", "done", "cancelled"] as const;
function dueDate(value: unknown): string | null {
  if (value == null) return null;
  if (
    typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  ) {
    throw new InputError("Invalid due date");
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
    case "add_task":
    case "update_task": {
      const add = op === "add_task";
      clean = {};
      if (add || data.name !== undefined) clean.name = text(data.name, 80);
      if (add || data.short_description !== undefined) {
        clean.short_description = text(data.short_description, 160);
      }
      if (data.full_description !== undefined) {
        clean.full_description = optionalText(data.full_description, 10000);
      }
      if (add || data.location_name !== undefined) {
        clean.location_name = optionalText(data.location_name, 100);
      }
      if (add || data.priority !== undefined) {
        clean.priority = integer(data.priority ?? 3, 1, 5);
      }
      if (add || data.due_date !== undefined) {
        clean.due_date = dueDate(data.due_date);
      }
      if (!add && data.status !== undefined) {
        if (!taskStatuses.includes(data.status as "open")) {
          throw new InputError("Invalid status");
        }
        clean.status = data.status;
      }
      if (
        !add && clean.full_description !== undefined &&
        clean.short_description === undefined
      ) {
        throw new InputError(
          "Changing the full description requires a new short description",
        );
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
    case "delete_task":
    case "delete_reminder":
      clean = { id: uuid(data.id) };
      break;
    case "set_profile": {
      clean = {};
      if (data.timezone !== undefined) {
        clean.timezone = timezone(data.timezone);
      }
      if (data.preferences !== undefined) {
        clean.preferences = data.preferences == null || data.preferences === ""
          ? ""
          : text(data.preferences, 4000);
      }
      if (Object.keys(clean).length === 0) {
        throw new InputError("Profile update must include a changed field");
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
  if (op === "update_task") {
    if (Object.keys(clean).length === 0) {
      throw new InputError("Update must include a changed field");
    }
    clean.id = uuid(data.id);
  }
  return { op, data: clean };
}
