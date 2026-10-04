import { InputError, object, type RecordData, text } from "../validation.ts";
import { resolveReferences } from "./task-context.ts";

export function queryObject(input: unknown, fields: string[]): RecordData {
  const query = object(input);
  if (Object.keys(query).some((field) => !fields.includes(field))) {
    throw new InputError("Invalid query field");
  }
  return query;
}

// Only safe, explicit fields enter context; never spread proposal payloads.
export function settingsReply(profile: RecordData, input: unknown): string {
  queryObject(input, []);
  return `Saved settings:\nTimezone: ${profile.timezone}\nPreferences: ${
    profile.preferences || "(none)"
  }`;
}

export function reminderSelection(reminders: RecordData[], reference: unknown) {
  return resolveReferences(
    reminders.map((row) => ({
      ...row,
      name: row.description,
      short_description: `${row.cron}; ${row.timezone}`,
    })),
    [text(reference, 1000)],
    "reminder",
  );
}

export function reminderReply(reminders: RecordData[], input: unknown): string {
  const query = queryObject(input, ["reminder", "active", "offset"]);
  const offset = query.offset ?? 0;
  if (
    typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
    offset > 100000
  ) {
    throw new InputError("Invalid reminder offset");
  }
  if (query.active != null && typeof query.active !== "boolean") {
    throw new InputError("Invalid reminder active filter");
  }
  let matching = reminders;
  if (query.reminder != null) {
    const resolution = reminderSelection(reminders, query.reminder);
    if (!resolution.ids) {
      return resolution.clarification;
    }
    matching = reminders.filter((row) => row.id === resolution.ids[0]);
  }
  if (query.active != null) {
    matching = matching.filter((row) => row.active === query.active);
  }
  return `Saved reminders: ${matching.length}${
    matching.length > offset + 10
      ? ` (page at offset ${offset}; next offset ${offset + 10})`
      : ""
  }\n${
    matching.slice(offset, offset + 10).map((row) =>
      `- [${row.id}] ${row.description}\nSchedule: ${row.cron}; timezone: ${row.timezone}; active: ${row.active}; next run: ${row.next_run}`
    ).join("\n") || "None."
  }`;
}
