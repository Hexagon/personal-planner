import {
  InputError,
  maxOpenTasks,
  object,
  type Proposal,
  type RecordData,
  text,
  uuid,
  validateProposal,
} from "./validation.ts";

export class AuthError extends Error {}

type Table = "profiles" | "tasks" | "messages" | "reminders";
type Entry = Deno.KvEntry<RecordData>;
const key = (table: Table, userId: string, id: string) =>
  ["planner", table, userId, id] as const;
const taskRevisionKey = (userId: string) =>
  ["planner", "task_revision", userId] as const;
const dueKey = (nextRun: string, userId: string, id: string) =>
  ["planner", "due", nextRun, userId, id] as const;
const now = () => new Date().toISOString();

async function entries(
  kv: Deno.Kv,
  prefix: Deno.KvKey,
): Promise<Entry[]> {
  const result: Entry[] = [];
  for await (const entry of kv.list<RecordData>({ prefix })) {
    result.push(entry);
  }
  return result;
}

function ordered(rows: RecordData[]): RecordData[] {
  return rows.sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)) ||
    String(a.id).localeCompare(String(b.id))
  );
}

function checkedProposal(value: unknown): Proposal {
  const proposal = object(value);
  const data = object(proposal.data);
  const allowed: Record<string, string[]> = {
    add_task: [
      "name",
      "short_description",
      "full_description",
      "location_name",
      "priority",
      "due_date",
    ],
    update_task: [
      "id",
      "name",
      "short_description",
      "full_description",
      "location_name",
      "priority",
      "due_date",
      "status",
    ],
    complete_tasks: ["ids"],
    delete_task: ["id"],
    set_profile: ["timezone", "preferences"],
    add_reminder: ["description", "cron", "timezone", "next_run"],
    delete_reminder: ["id"],
  };
  const fields = allowed[String(proposal.op)];
  if (
    !fields || Object.keys(data).some((field) => !fields.includes(field)) ||
    Object.keys(proposal).some((field) => field !== "op" && field !== "data")
  ) {
    throw new InputError("Invalid proposal");
  }
  return validateProposal(proposal);
}

export class Database {
  constructor(
    private kv: Deno.Kv,
    readonly userId: string,
  ) {}

  async list(table: Table, columns = "*"): Promise<RecordData[]> {
    const rows = table === "profiles"
      ? await (async () => {
        const profile = await this.kv.get<RecordData>([
          "planner",
          "profiles",
          this.userId,
        ]);
        return profile.value ? [profile.value] : [];
      })()
      : (await entries(this.kv, ["planner", table, this.userId])).map((entry) =>
        entry.value
      );
    let result = ordered(rows);
    if (table === "messages") result = result.slice(0, 100);
    if (columns !== "*") {
      const selected = columns.split(",");
      result = result.map((row) =>
        Object.fromEntries(selected.filter((field) => field in row).map(
          (field) => [field, row[field]],
        ))
      );
    }
    return result;
  }

  async insert(table: "messages", data: RecordData): Promise<RecordData[]> {
    if (table !== "messages") throw new InputError("Invalid table");
    const role = data.role;
    if (role !== "user" && role !== "assistant") {
      throw new InputError("Invalid message");
    }
    const content = text(data.content, 20000);
    const proposal = data.proposal == null ? null : object(data.proposal);
    if (role === "user" && proposal !== null) {
      throw new InputError("Invalid message");
    }
    if (proposal && new TextEncoder().encode(JSON.stringify(proposal)).length > 65536) {
      throw new InputError("Proposal is too large");
    }
    const message: RecordData = {
      id: crypto.randomUUID(),
      user_id: this.userId,
      role,
      content,
      proposal,
      action_state: proposal ? "pending" : null,
      created_at: now(),
    };
    const messageKey = key("messages", this.userId, String(message.id));
    const result = await this.kv.atomic().check({
      key: messageKey,
      versionstamp: null,
    }).set(messageKey, message).commit();
    if (!result.ok) throw new Error("Could not append message");
    return [message];
  }

  async ensureProfile(): Promise<void> {
    const profileKey = ["planner", "profiles", this.userId] as const;
    const entry = await this.kv.get<RecordData>(profileKey);
    if (entry.value) return;
    await this.kv.atomic().check({
      key: profileKey,
      versionstamp: null,
    }).set(profileKey, {
      id: this.userId,
      timezone: "UTC",
      preferences: "",
      created_at: now(),
    }).commit();
  }

  async owned(table: "tasks" | "reminders", id: unknown): Promise<RecordData> {
    const rowId = uuid(id);
    const entry = await this.kv.get<RecordData>(key(table, this.userId, rowId));
    if (!entry.value) throw new InputError("Record not found in your account");
    return entry.value;
  }

  async confirm(messageId: unknown, cancel: boolean): Promise<boolean> {
    const id = uuid(messageId);
    const messageKey = key("messages", this.userId, id);
    for (let attempt = 0; attempt < 10; attempt++) {
      const messageEntry = await this.kv.get<RecordData>(messageKey);
      const message = messageEntry.value;
      if (
        !message || message.role !== "assistant" ||
        message.action_state !== "pending"
      ) return false;
      const checks: Deno.KvCheck[] = [{
        key: messageKey,
        versionstamp: messageEntry.versionstamp,
      }];
      const atomic = this.kv.atomic();
      if (cancel) {
        const result = await atomic.check(...checks).set(messageKey, {
          ...message,
          action_state: "cancelled",
        }).commit();
        if (result.ok) return true;
        continue;
      }

      const proposal = checkedProposal(message.proposal);
      const data = proposal.data;
      const timestamp = now();
      const nextMessage = { ...message, action_state: "confirmed" };
      let taskRevision: number | undefined;
      const writes: Array<
        { type: "set"; key: Deno.KvKey; value: unknown } | {
          type: "delete";
          key: Deno.KvKey;
        }
      > = [];
      let target: RecordData | undefined;

      if (
        proposal.op === "add_task" || proposal.op === "update_task" ||
        proposal.op === "delete_task" || proposal.op === "complete_tasks"
      ) {
        const revisionKey = taskRevisionKey(this.userId);
        const revisionEntry = await this.kv.get<number>(revisionKey);
        taskRevision = (revisionEntry.value ?? 0) + 1;
        checks.push({
          key: revisionKey,
          versionstamp: revisionEntry.versionstamp,
        });
        const taskEntries = await entries(
          this.kv,
          ["planner", "tasks", this.userId],
        );
        const tasks = taskEntries.map((entry) => entry.value);
        const taskEntryById = new Map(
          taskEntries.map((entry) => [String(entry.value.id), entry]),
        );
        if (proposal.op === "add_task") {
          if (tasks.filter((task) => task.status === "open").length >= maxOpenTasks) {
            throw new InputError(
              `At most ${maxOpenTasks} open tasks are allowed; complete or remove some first`,
            );
          }
          const task: RecordData = {
            id: crypto.randomUUID(),
            user_id: this.userId,
            name: data.name,
            short_description: data.short_description,
            full_description: data.full_description ?? null,
            location_name: data.location_name ?? null,
            priority: data.priority ?? 3,
            due_date: data.due_date ?? null,
            status: "open",
            created_at: timestamp,
            updated_at: timestamp,
            completed_at: null,
          };
          writes.push({
            type: "set",
            key: key("tasks", this.userId, String(task.id)),
            value: task,
          });
        } else if (
          proposal.op === "update_task" || proposal.op === "delete_task"
        ) {
          target = taskEntryById.get(String(data.id))?.value;
          const taskEntry = taskEntryById.get(String(data.id));
          if (!target || !taskEntry) {
            throw new InputError("Record not found in your account");
          }
          checks.push({
            key: taskEntry.key,
            versionstamp: taskEntry.versionstamp,
          });
          if (proposal.op === "delete_task") {
            writes.push({ type: "delete", key: taskEntry.key });
          } else {
            if (
              data.status === "open" && target.status !== "open" &&
              tasks.filter((task) => task.status === "open").length >=
                maxOpenTasks
            ) {
              throw new InputError(
                `At most ${maxOpenTasks} open tasks are allowed; complete or remove some first`,
              );
            }
            const status = data.status ?? target.status;
            writes.push({
              type: "set",
              key: taskEntry.key,
              value: {
                ...target,
                ...data,
                status,
                updated_at: timestamp,
                completed_at: data.status === undefined
                  ? target.completed_at
                  : status !== "done"
                  ? null
                  : target.status === "done"
                  ? target.completed_at
                  : timestamp,
              },
            });
          }
        } else {
          const ids = data.ids as string[];
          const selected = ids.map((taskId) => taskEntryById.get(taskId));
          if (selected.some((entry) => !entry || entry.value.status !== "open")) {
            throw new InputError("Every task must be owned and open");
          }
          for (const entry of selected as Entry[]) {
            checks.push({ key: entry.key, versionstamp: entry.versionstamp });
            writes.push({
              type: "set",
              key: entry.key,
              value: {
                ...entry.value,
                status: "done",
                completed_at: timestamp,
                updated_at: timestamp,
              },
            });
          }
        }
        writes.push({
          type: "set",
          key: revisionKey,
          value: taskRevision,
        });
      } else if (proposal.op === "set_profile") {
        const profileKey = ["planner", "profiles", this.userId] as const;
        const profileEntry = await this.kv.get<RecordData>(profileKey);
        checks.push({
          key: profileKey,
          versionstamp: profileEntry.versionstamp,
        });
        writes.push({
          type: "set",
          key: profileKey,
          value: {
            id: this.userId,
            timezone: data.timezone ?? profileEntry.value?.timezone ?? "UTC",
            preferences: data.preferences ??
              profileEntry.value?.preferences ?? "",
            created_at: profileEntry.value?.created_at ?? timestamp,
          },
        });
      } else if (proposal.op === "delete_reminder") {
        const reminderKey = key("reminders", this.userId, String(data.id));
        const reminderEntry = await this.kv.get<RecordData>(reminderKey);
        if (!reminderEntry.value) {
          throw new InputError("Record not found in your account");
        }
        checks.push({
          key: reminderKey,
          versionstamp: reminderEntry.versionstamp,
        });
        writes.push({ type: "delete", key: reminderKey });
        writes.push({
          type: "delete",
          key: dueKey(
            String(reminderEntry.value.next_run),
            this.userId,
            String(data.id),
          ),
        });
      } else if (proposal.op === "add_reminder") {
        const reminderId = crypto.randomUUID();
        const reminder: RecordData = {
          id: reminderId,
          user_id: this.userId,
          description: data.description,
          cron: data.cron,
          timezone: data.timezone,
          next_run: data.next_run,
          active: true,
          created_at: timestamp,
        };
        const reminderKey = key("reminders", this.userId, reminderId);
        checks.push({ key: reminderKey, versionstamp: null });
        writes.push({ type: "set", key: reminderKey, value: reminder });
        writes.push({
          type: "set",
          key: dueKey(String(reminder.next_run), this.userId, reminderId),
          value: reminderId,
        });
      } else {
        throw new InputError("Unsupported action");
      }

      let transaction = atomic.check(...checks);
      for (const write of writes) {
        transaction = write.type === "set"
          ? transaction.set(write.key, write.value)
          : transaction.delete(write.key);
      }
      const result = await transaction.set(messageKey, nextMessage).commit();
      if (result.ok) return true;
    }
    throw new Error("Confirmation conflicted; retry the action");
  }
}

export interface DueReminder {
  userId: string;
  id: string;
  row: RecordData;
  versionstamp: string;
}

export async function dueReminders(
  kv: Deno.Kv,
  before: string,
  limit = 50,
): Promise<DueReminder[]> {
  const result: DueReminder[] = [];
  const end = ["planner", "due", `${before}\uffff`] as const;
  for await (const index of kv.list<string>({
    start: ["planner", "due"],
    end,
    limit,
  })) {
    const [, , , userId, id] = index.key as Deno.KvKey;
    if (typeof userId !== "string" || typeof id !== "string") continue;
    const entry = await kv.get<RecordData>(key("reminders", userId, id));
    if (
      entry.value?.active === true &&
      entry.value.next_run === index.key[2]
    ) {
      result.push({ userId, id, row: entry.value, versionstamp: entry.versionstamp! });
    }
  }
  return result;
}

export async function deliverReminder(
  kv: Deno.Kv,
  reminder: DueReminder,
  nextRun: string,
): Promise<boolean> {
  const reminderKey = key("reminders", reminder.userId, reminder.id);
  const message: RecordData = {
    id: crypto.randomUUID(),
    user_id: reminder.userId,
    role: "assistant",
    content: `Reminder: ${String(reminder.row.description).slice(0, 2000)}`,
    proposal: null,
    action_state: null,
    created_at: now(),
  };
  const messageKey = key("messages", reminder.userId, String(message.id));
  const result = await kv.atomic().check(
    { key: reminderKey, versionstamp: reminder.versionstamp },
    { key: messageKey, versionstamp: null },
  ).delete(
    dueKey(String(reminder.row.next_run), reminder.userId, reminder.id),
  ).set(reminderKey, { ...reminder.row, next_run: nextRun }).set(
    dueKey(nextRun, reminder.userId, reminder.id),
    reminder.id,
  ).set(messageKey, message).commit();
  return result.ok;
}

export async function quarantineReminder(
  kv: Deno.Kv,
  reminder: DueReminder,
): Promise<boolean> {
  const reminderKey = key("reminders", reminder.userId, reminder.id);
  const result = await kv.atomic().check({
    key: reminderKey,
    versionstamp: reminder.versionstamp,
  }).delete(
    dueKey(String(reminder.row.next_run), reminder.userId, reminder.id),
  ).set(reminderKey, { ...reminder.row, active: false }).commit();
  return result.ok;
}
