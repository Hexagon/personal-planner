import type { RecordData } from "../validation.ts";
export function financialContext(
  assets: RecordData[],
  tasks: RecordData[],
  budget: unknown,
) {
  return {
    informational_asset_value_minor: assets.reduce(
      (sum, asset) => sum + Number(asset.value_minor),
      0,
    ),
    known_task_cost_minor: tasks.reduce(
      (sum, task) => sum + Number(task.estimated_cost_minor ?? 0),
      0,
    ),
    unknown_cost_count:
      tasks.filter((task) => task.estimated_cost_minor == null).length,
    available_budget_minor: typeof budget === "number" ? budget : null,
  };
}
export function fitPlan(tasks: RecordData[], budget: number, minutes: number) {
  let cost = 0, duration = 0;
  const selected: unknown[] = [];
  for (const task of tasks) {
    if (task.estimated_cost_minor == null || task.duration_minutes == null) {
      continue;
    }
    const nextCost = cost + Number(task.estimated_cost_minor),
      nextDuration = duration + Number(task.duration_minutes);
    if (nextCost <= budget && nextDuration <= minutes) {
      selected.push(task.id);
      cost = nextCost;
      duration = nextDuration;
    }
  }
  return { task_ids: selected, cost_minor: cost, duration_minutes: duration };
}
export const financeRole =
  "Financial guidance: use code-calculated totals and explicitly available budget only. Asset valuations are NOT spending money. Costs/durations marked null are unknown, not zero. All money is integer minor units in the profile currency (no conversion). Only simple budgeting trade-offs, no investment/tax/legal advice or transactions.";
