import type { RecordData } from "../validation.ts";

export const urgencies = ["overdue", "today", "soon", "later", "none"] as const;
export type Urgency = typeof urgencies[number];
const weights: Record<Urgency, number> = {
  overdue: 5,
  today: 4,
  soon: 2,
  later: 0,
  none: 0,
};

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// `today` is a YYYY-MM-DD date in the profile timezone.
export function urgency(dueDate: unknown, today: string): Urgency {
  if (typeof dueDate !== "string") return "none";
  if (dueDate < today) return "overdue";
  if (dueDate === today) return "today";
  return dueDate <= addDays(today, 3) ? "soon" : "later";
}

export function prioritize(tasks: RecordData[], today: string): RecordData[] {
  const score = (task: RecordData) =>
    Number(task.priority) + weights[urgency(task.due_date, today)];
  const due = (task: RecordData) =>
    typeof task.due_date === "string" ? task.due_date : "9999-12-31";
  return tasks.filter((task) => task.status === "open").toSorted((a, b) =>
    score(b) - score(a) || due(a).localeCompare(due(b)) ||
    String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) ||
    String(a.id).localeCompare(String(b.id))
  );
}
export const taskRole =
  "Task tracking: every planner item is a task. Suggest clear priorities from priority, urgency and due dates. Never change records without a validated, confirmed proposal. Updates contain only explicitly changed fields.";
