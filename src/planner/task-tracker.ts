import type { RecordData } from "../validation.ts";
export function prioritize(tasks: RecordData[], today: string): RecordData[] {
  const score = (task: RecordData) =>
    Number(task.base_priority) +
    (typeof task.deadline === "string" && task.deadline <= today ? 5 : 0);
  return tasks.filter((task) => task.status === "open").toSorted((a, b) =>
    score(b) - score(a) || String(a.id).localeCompare(String(b.id))
  );
}
export const taskRole =
  "Task tracking: suggest clear priorities, respect saved status and deadlines. Never change records without a validated, confirmed proposal. Updates contain only explicitly changed fields.";
