import {
  InputError,
  maxOpenTasks,
  nextOccurrence,
  object,
  type Proposal,
  type RecordData,
  text,
  timezone,
  uuid,
  validateProposal,
} from "./validation.ts";

type Table = "profiles" | "tasks" | "messages" | "reminders";
type Entry = Deno.KvEntry<RecordData>;
type KvCheck = Parameters<ReturnType<Deno.Kv["atomic"]>["check"]>[number];
const key = (table: Table, userId: string, id: string) =>
  ["planner", table, userId, id] as const;
// Every logical task change bumps this key atomically; compaction is state-preserving.
const taskRevisionKey = (userId: string) =>
  ["planner", "task_revision", userId] as const;
const taskDescriptionKey = (userId: string, id: string) =>
  ["planner", "task_descriptions", userId, id] as const;
const taskCompletionKey = (userId: string, id: string) =>
  ["planner", "task_completions", userId, id] as const;
const messageDateKey = (userId: string, createdAt: string, id: string) =>
  ["planner", "message_dates", userId, createdAt, id] as const;
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

async function compactTaskCompletions(
  kv: Deno.Kv,
  userId: string,
): Promise<void> {
  const completionPrefix = ["planner", "task_completions", userId] as const;
  const revisionKey = taskRevisionKey(userId);
  for (const listed of await entries(kv, completionPrefix)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const eventEntry = await kv.get<RecordData>(listed.key);
      const event = eventEntry.value;
      if (!event) break;
      if (
        !Array.isArray(event.ids) || typeof event.revision !== "number" ||
        typeof event.completed_at !== "string"
      ) break;
      const ids = event.ids.filter((id): id is string =>
        typeof id === "string"
      );
      const batch = ids.slice(0, 8);
      const revisionEntry = await kv.get<number>(revisionKey);
      const taskEntries = await kv.getMany(
        batch.map((id) => key("tasks", userId, id)),
      ) as Deno.KvEntryMaybe<RecordData>[];
      let transaction = kv.atomic().check(
        { key: eventEntry.key, versionstamp: eventEntry.versionstamp },
        { key: revisionKey, versionstamp: revisionEntry.versionstamp },
        ...taskEntries.map((entry) => ({
          key: entry.key,
          versionstamp: entry.versionstamp,
        })),
      );
      for (let index = 0; index < batch.length; index++) {
        const task = taskEntries[index].value;
        if (task && Number(task.task_revision ?? 0) < event.revision) {
          transaction = transaction.set(taskEntries[index].key, {
            ...task,
            status: "done",
            completed_at: event.completed_at,
            updated_at: event.completed_at,
            task_revision: event.revision,
          });
        }
      }
      const remaining = ids.slice(batch.length);
      transaction = remaining.length
        ? transaction.set(eventEntry.key, { ...event, ids: remaining })
        : transaction.delete(eventEntry.key);
      if ((await transaction.commit()).ok) {
        if (!remaining.length) break;
      }
    }
  }
}

async function compactTaskDescriptions(
  kv: Deno.Kv,
  userId: string,
): Promise<void> {
  const taskEntries = await entries(kv, ["planner", "tasks", userId]);
  const revisionKey = taskRevisionKey(userId);
  for (const listed of taskEntries) {
    let migrated = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const taskEntry = await kv.get<RecordData>(listed.key);
      const task = taskEntry.value;
      if (!task || !("full_description" in task)) {
        migrated = true;
        break;
      }
      const id = String(task.id);
      const descriptionKey = taskDescriptionKey(userId, id);
      const [revisionEntry, descriptionEntry] = await Promise.all([
        kv.get<number>(revisionKey),
        kv.get<unknown>(descriptionKey),
      ]);
      const revision = (revisionEntry.value ?? 0) + 1;
      const compactTask: RecordData = { ...task, task_revision: revision };
      delete compactTask.full_description;
      const result = await kv.atomic().check(
        { key: taskEntry.key, versionstamp: taskEntry.versionstamp },
        { key: revisionKey, versionstamp: revisionEntry.versionstamp },
        { key: descriptionKey, versionstamp: descriptionEntry.versionstamp },
      ).set(taskEntry.key, compactTask).set(
        descriptionKey,
        task.full_description,
      ).set(revisionKey, revision).commit();
      if (result.ok) {
        migrated = true;
        break;
      }
    }
    if (!migrated) throw new Error("Task description migration conflicted");
  }
}

function latestCompletions(
  completions: Entry[],
  onlyTaskId?: string,
): Map<string, { revision: number; completedAt: string }> {
  const latest = new Map<string, { revision: number; completedAt: string }>();
  for (const { value } of completions) {
    if (
      !Array.isArray(value.ids) || typeof value.revision !== "number" ||
      typeof value.completed_at !== "string"
    ) continue;
    for (const id of value.ids) {
      if (typeof id !== "string") continue;
      if (onlyTaskId && id !== onlyTaskId) continue;
      const completion = latest.get(id);
      if (!completion || value.revision > completion.revision) {
        latest.set(id, {
          revision: value.revision,
          completedAt: value.completed_at,
        });
      }
    }
  }
  return latest;
}

function effectiveTask(
  task: RecordData,
  completions: Map<string, { revision: number; completedAt: string }>,
): RecordData {
  const completion = completions.get(String(task.id));
  if (completion && completion.revision > Number(task.task_revision ?? 0)) {
    return {
      ...task,
      status: "done",
      completed_at: completion.completedAt,
      updated_at: completion.completedAt,
    };
  }
  return task;
}

async function effectiveTaskEntries(
  kv: Deno.Kv,
  userId: string,
): Promise<Array<{ entry: Entry; row: RecordData }>> {
  await compactTaskDescriptions(kv, userId);
  await compactTaskCompletions(kv, userId);
  const [tasks, completions] = await Promise.all([
    entries(kv, ["planner", "tasks", userId]),
    entries(kv, ["planner", "task_completions", userId]),
  ]);
  const latest = latestCompletions(completions);
  return tasks.map((entry) => ({
    entry,
    row: effectiveTask(entry.value, latest),
  }));
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
    set_profile: ["preferences"],
    add_reminder: ["description", "cron", "timezone", "next_run"],
    update_reminder: ["id", "description", "cron", "timezone", "active"],
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

  // Scan one bounded date-index page for conversation history.
  async messagePage(cursor?: unknown) {
    const prefix = ["planner", "message_dates", this.userId] as const;
    let end: Deno.KvKey | undefined;
    if (cursor !== undefined && cursor !== null) {
      let parsed: RecordData;
      try {
        parsed = object(JSON.parse(text(cursor, 200)));
      } catch {
        throw new InputError("Invalid message cursor");
      }
      if (
        Object.keys(parsed).some((field) =>
          !["created_at", "id"].includes(field)
        ) ||
        typeof parsed.created_at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
          parsed.created_at,
        ) ||
        !Number.isFinite(Date.parse(parsed.created_at))
      ) throw new InputError("Invalid message cursor");
      end = [...prefix, parsed.created_at, uuid(parsed.id)];
    }
    const indexes = [];
    for await (
      const index of this.kv.list<string>(
        end ? { prefix, end } : { prefix },
        { reverse: true, limit: 101 },
      )
    ) indexes.push(index);
    const hasMore = indexes.length > 100;
    const page = indexes.slice(0, 100);
    const messages: RecordData[] = [];
    for (let offset = 0; offset < page.length; offset += 10) {
      const rows = await this.kv.getMany(
        page.slice(offset, offset + 10).map((index) =>
          key("messages", this.userId, String(index.key[4]))
        ),
      ) as Deno.KvEntryMaybe<RecordData>[];
      for (const row of rows) {
        if (row.value) messages.push(row.value);
      }
    }
    const last = page.at(-1);
    return {
      messages,
      cursor: hasMore && last
        ? JSON.stringify({ created_at: last.key[3], id: last.key[4] })
        : null,
    };
  }

  async ownedMessage(id: unknown): Promise<RecordData | null> {
    return (await this.kv.get<RecordData>(
      key("messages", this.userId, uuid(id)),
    )).value;
  }

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
      : table === "messages"
      ? await (async () => {
        const result: RecordData[] = [];
        const ids: string[] = [];
        for await (
          const index of this.kv.list<string>({
            prefix: ["planner", "message_dates", this.userId],
          }, { reverse: true, limit: 100 })
        ) {
          const id = index.key[4];
          if (typeof id === "string") ids.push(id);
        }
        for (let offset = 0; offset < ids.length; offset += 10) {
          const page = await this.kv.getMany(
            ids.slice(offset, offset + 10).map((id) =>
              key("messages", this.userId, id)
            ),
          ) as Deno.KvEntryMaybe<RecordData>[];
          for (const message of page) {
            if (message.value) result.push(message.value);
          }
        }
        return result;
      })()
      : table === "tasks"
      ? (await effectiveTaskEntries(this.kv, this.userId)).map(({ row }) => row)
      : (await entries(this.kv, ["planner", table, this.userId])).map((
        entry,
      ) => entry.value);
    let result = ordered(rows);
    if (columns !== "*") {
      const selected = columns.split(",");
      result = result.map((row) =>
        Object.fromEntries(
          selected.filter((field) => field in row).map(
            (field) => [field, row[field]],
          ),
        )
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
    if (
      proposal &&
      new TextEncoder().encode(JSON.stringify(proposal)).length > 65536
    ) {
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
    }).set(messageKey, message).set(
      messageDateKey(
        this.userId,
        String(message.created_at),
        String(message.id),
      ),
      message.id,
    ).commit();
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
      timezone_configured: false,
      preferences: "",
      created_at: now(),
    }).commit();
  }

  async saveTimezone(value: unknown): Promise<string> {
    const zone = timezone(value);
    const profileKey = ["planner", "profiles", this.userId] as const;
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await this.kv.get<RecordData>(profileKey);
      const result = await this.kv.atomic().check(entry).set(profileKey, {
        id: this.userId,
        timezone: zone,
        timezone_configured: true,
        preferences: entry.value?.preferences ?? "",
        created_at: entry.value?.created_at ?? now(),
      }).commit();
      if (result.ok) return zone;
    }
    throw new InputError("Settings changed elsewhere. Please save again.");
  }

  async owned(table: "tasks" | "reminders", id: unknown): Promise<RecordData> {
    const rowId = uuid(id);
    if (table === "tasks") {
      await compactTaskDescriptions(this.kv, this.userId);
      await compactTaskCompletions(this.kv, this.userId);
    }
    const entry = await this.kv.get<RecordData>(key(table, this.userId, rowId));
    if (!entry.value) throw new InputError("Record not found in your account");
    if (table === "tasks") {
      const completions = await entries(
        this.kv,
        ["planner", "task_completions", this.userId],
      );
      return effectiveTask(
        entry.value,
        latestCompletions(completions, rowId),
      );
    }
    return entry.value;
  }

  async ownedTaskDetail(id: unknown): Promise<RecordData> {
    const row = await this.owned("tasks", id);
    const description = await this.kv.get<string>(
      taskDescriptionKey(this.userId, String(row.id)),
    );
    if (description.value) row.full_description = description.value;
    return row;
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
      const checks: KvCheck[] = [{
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
        const taskSnapshots = await effectiveTaskEntries(
          this.kv,
          this.userId,
        );
        const tasks = taskSnapshots.map(({ row }) => row);
        const taskById = new Map(
          tasks.map((task) => [String(task.id), task]),
        );
        const taskEntryById = new Map(
          taskSnapshots.map(({ entry, row }) => [String(row.id), entry]),
        );
        if (proposal.op === "add_task") {
          if (
            tasks.filter((task) => task.status === "open").length >=
              maxOpenTasks
          ) {
            throw new InputError(
              `At most ${maxOpenTasks} open tasks are allowed; complete or remove some first`,
            );
          }
          const task: RecordData = {
            id: crypto.randomUUID(),
            user_id: this.userId,
            name: data.name,
            short_description: data.short_description,
            location_name: data.location_name ?? null,
            priority: data.priority ?? 3,
            due_date: data.due_date ?? null,
            status: "open",
            created_at: timestamp,
            updated_at: timestamp,
            completed_at: null,
            task_revision: taskRevision,
          };
          const taskId = String(task.id);
          const newTaskKey = key("tasks", this.userId, taskId);
          const descriptionKey = taskDescriptionKey(this.userId, taskId);
          checks.push({ key: newTaskKey, versionstamp: null });
          checks.push({ key: descriptionKey, versionstamp: null });
          writes.push({
            type: "set",
            key: newTaskKey,
            value: task,
          });
          writes.push({
            type: "set",
            key: descriptionKey,
            value: data.full_description ?? null,
          });
        } else if (
          proposal.op === "update_task" || proposal.op === "delete_task"
        ) {
          target = taskById.get(String(data.id));
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
            writes.push({
              type: "delete",
              key: taskDescriptionKey(this.userId, String(data.id)),
            });
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
            const updatedTask = { ...target, ...data };
            delete updatedTask.full_description;
            writes.push({
              type: "set",
              key: taskEntry.key,
              value: {
                ...updatedTask,
                task_revision: taskRevision,
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
            if ("full_description" in data) {
              writes.push({
                type: "set",
                key: taskDescriptionKey(this.userId, String(data.id)),
                value: data.full_description ?? null,
              });
            }
          }
        } else {
          const ids = data.ids as string[];
          const selected = ids.map((taskId) => taskById.get(taskId));
          if (
            selected.some((task) => !task || task.status !== "open")
          ) {
            throw new InputError("Every task must be owned and open");
          }
          const completionKey = taskCompletionKey(
            this.userId,
            crypto.randomUUID(),
          );
          checks.push({ key: completionKey, versionstamp: null });
          writes.push({
            type: "set",
            key: completionKey,
            value: {
              ids,
              revision: taskRevision,
              completed_at: timestamp,
            },
          });
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
            timezone: profileEntry.value?.timezone ?? "UTC",
            timezone_configured: profileEntry.value
              ? profileEntry.value.timezone_configured !== false
              : false,
            preferences: data.preferences ??
              profileEntry.value?.preferences ?? "",
            created_at: profileEntry.value?.created_at ?? timestamp,
          },
        });
      } else if (
        proposal.op === "delete_reminder" ||
        proposal.op === "update_reminder"
      ) {
        const reminderKey = key("reminders", this.userId, String(data.id));
        const reminderEntry = await this.kv.get<RecordData>(reminderKey);
        if (!reminderEntry.value) {
          throw new InputError("Record not found in your account");
        }
        checks.push({
          key: reminderKey,
          versionstamp: reminderEntry.versionstamp,
        });
        const current = reminderEntry.value;
        const oldDueKey = dueKey(
          String(current.next_run),
          this.userId,
          String(data.id),
        );
        if (proposal.op === "delete_reminder") {
          writes.push({ type: "delete", key: reminderKey });
          writes.push({ type: "delete", key: oldDueKey });
        } else {
          const cron = data.cron ?? current.cron;
          const reminderTimezone = data.timezone ?? current.timezone;
          const active = data.active ?? current.active;
          nextOccurrence(cron, reminderTimezone);
          const scheduleChanged = cron !== current.cron ||
            reminderTimezone !== current.timezone;
          const becomingActive = active === true &&
            current.active !== true;
          const nextRun = active === true &&
              (scheduleChanged || becomingActive)
            ? nextOccurrence(cron, reminderTimezone)
            : current.next_run;
          const reminder = {
            ...current,
            ...data,
            cron,
            timezone: reminderTimezone,
            active,
            next_run: nextRun,
            updated_at: timestamp,
          };
          writes.push({ type: "delete", key: oldDueKey });
          writes.push({ type: "set", key: reminderKey, value: reminder });
          if (reminder.active === true) {
            writes.push({
              type: "set",
              key: dueKey(
                String(reminder.next_run),
                this.userId,
                String(data.id),
              ),
              value: String(data.id),
            });
          }
        }
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
  const staleIndexes: Deno.KvKey[] = [];
  const indexes: Array<{ key: Deno.KvKey; userId: string; id: string }> = [];
  // The suffix makes the timestamp upper bound inclusive in lexicographic order.
  const end = ["planner", "due", `${before}\uffff`] as const;
  for await (
    const index of kv.list<string>({
      start: ["planner", "due"],
      end,
    }, { limit })
  ) {
    const [, , , userId, id] = index.key as Deno.KvKey;
    if (typeof userId !== "string" || typeof id !== "string") {
      staleIndexes.push(index.key);
      continue;
    }
    indexes.push({ key: index.key, userId, id });
  }
  for (let offset = 0; offset < indexes.length; offset += 10) {
    const batch = indexes.slice(offset, offset + 10);
    const reminders = await kv.getMany(
      batch.map(({ userId, id }) => key("reminders", userId, id)),
    ) as Deno.KvEntryMaybe<RecordData>[];
    for (let index = 0; index < batch.length; index++) {
      const reminder = reminders[index];
      const dueIndex = batch[index];
      if (
        reminder.value?.active === true &&
        reminder.value.next_run === dueIndex.key[2]
      ) {
        result.push({
          userId: dueIndex.userId,
          id: dueIndex.id,
          row: reminder.value,
          versionstamp: reminder.versionstamp!,
        });
      } else {
        staleIndexes.push(dueIndex.key);
      }
    }
  }
  for (let offset = 0; offset < staleIndexes.length; offset += 10) {
    let transaction = kv.atomic();
    for (const index of staleIndexes.slice(offset, offset + 10)) {
      transaction = transaction.delete(index);
    }
    await transaction.commit();
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
  const transaction = kv.atomic().check(
    { key: reminderKey, versionstamp: reminder.versionstamp },
    { key: messageKey, versionstamp: null },
  ).delete(
    dueKey(String(reminder.row.next_run), reminder.userId, reminder.id),
  ).set(reminderKey, { ...reminder.row, next_run: nextRun }).set(
    dueKey(nextRun, reminder.userId, reminder.id),
    reminder.id,
  ).set(messageKey, message).set(
    messageDateKey(
      reminder.userId,
      String(message.created_at),
      String(message.id),
    ),
    message.id,
  );
  if (
    !Number.isFinite(Date.parse(nextRun)) || Date.parse(nextRun) <= Date.now()
  ) {
    return false;
  }
  const result = await transaction.commit();
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
