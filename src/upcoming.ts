import type { Database } from "./db.ts";

export async function upcoming(db: Database, now = new Date()) {
  const [profiles, tasks, reminders] = await Promise.all([
    db.list("profiles", "timezone"),
    db.list(
      "tasks",
      "id,name,short_description,location_name,priority,due_date,status",
    ),
    db.list("reminders", "id,description,timezone,next_run,active"),
  ]);
  const timezone = String(profiles[0]?.timezone ?? "UTC");
  const day = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
  const today = day(now);
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowDay = tomorrow.toISOString().slice(0, 10);
  const group = (date: string) =>
    date < today
      ? "Overdue"
      : date === today
      ? "Today"
      : date === tomorrowDay
      ? "Tomorrow"
      : "Later";
  const items = [
    ...tasks.filter((task) =>
      task.status === "open" && typeof task.due_date === "string"
    ).map((task) => ({
      id: String(task.id),
      kind: "task",
      title: String(task.name),
      description: String(task.short_description),
      location: task.location_name == null ? null : String(task.location_name),
      priority: Number(task.priority),
      when: String(task.due_date),
      timezone,
      day: String(task.due_date),
      group: group(String(task.due_date)),
      attention: String(task.due_date) <= today,
      waiting: false,
    })),
    ...reminders.filter((reminder) =>
      reminder.active === true && typeof reminder.next_run === "string" &&
      Number.isFinite(Date.parse(reminder.next_run))
    ).map((reminder) => {
      const when = String(reminder.next_run);
      const date = day(new Date(when));
      return {
        id: String(reminder.id),
        kind: "reminder",
        title: String(reminder.description),
        description: "",
        location: null,
        priority: 0,
        when,
        timezone: String(reminder.timezone),
        day: date,
        group: group(date),
        attention: Date.parse(when) <= now.getTime() + 24 * 60 * 60 * 1000,
        waiting: Date.parse(when) <= now.getTime(),
      };
    }),
  ];
  items.sort((a, b) =>
    a.day.localeCompare(b.day) || a.when.localeCompare(b.when) ||
    b.priority - a.priority || a.title.localeCompare(b.title) ||
    a.id.localeCompare(b.id)
  );
  return { timezone, items };
}
