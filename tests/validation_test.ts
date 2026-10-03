import {
  InputError,
  location,
  nextOccurrence,
  validateProposal,
} from "../src/validation.ts";
import { financialContext, fitPlan } from "../src/planner/budget-advisor.ts";
import { distanceKm } from "../src/planner/geo-planner.ts";
import { prioritize } from "../src/planner/task-tracker.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function rejects(callback: () => unknown) {
  try {
    callback();
  } catch (error) {
    if (error instanceof InputError) return;
    throw error;
  }
  throw new Error("Expected invalid input to be rejected");
}
Deno.test("asset amounts are integers and unknown fields cannot assign ownership", () => {
  const valid = validateProposal({
    op: "add_asset",
    data: { description: "Bike", value_minor: 60000, user_id: "someone-else" },
  });
  equal(valid, {
    op: "add_asset",
    data: { description: "Bike", value_minor: 60000, notes: "" },
  });
  for (const value_minor of [-1, 0.1, "100", 1e13, NaN]) {
    rejects(() =>
      validateProposal({
        op: "add_asset",
        data: { description: "Bike", value_minor },
      })
    );
  }
});
Deno.test("reject unsupported actions, empty text, bad IDs, status and dates", () => {
  rejects(() => validateProposal({ op: "run_sql", data: {} }));
  rejects(() =>
    validateProposal({ op: "add_task", data: { description: " " } })
  );
  rejects(() =>
    validateProposal({ op: "delete_task", data: { id: "id&user_id=eq.other" } })
  );
  rejects(() =>
    validateProposal({
      op: "add_task",
      data: { description: "Errand", status: "unknown" },
    })
  );
  rejects(() =>
    validateProposal({
      op: "add_task",
      data: { description: "Errand", deadline: "2026-02-30" },
    })
  );
});
Deno.test("task unknown costs and duration stay null, priority is bounded", () => {
  const task = validateProposal({
    op: "add_task",
    data: { description: "Errand" },
  });
  equal(task.data.estimated_cost_minor, null);
  equal(task.data.duration_minutes, null);
  rejects(() =>
    validateProposal({
      op: "add_task",
      data: { description: "Errand", base_priority: 6 },
    })
  );
});
Deno.test("partial update proposals keep only changed fields", () => {
  equal(
    validateProposal({
      op: "update_task",
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        base_priority: 5,
      },
    }),
    {
      op: "update_task",
      data: {
        base_priority: 5,
        id: "11111111-1111-4111-8111-111111111111",
      },
    },
  );
  equal(
    validateProposal({
      op: "set_profile",
      data: { preferences: "Quiet mornings" },
    }),
    { op: "set_profile", data: { preferences: "Quiet mornings" } },
  );
  rejects(() =>
    validateProposal({
      op: "update_task",
      data: { id: "11111111-1111-4111-8111-111111111111" },
    })
  );
});
Deno.test("generic task context is allowlisted and bounded", () => {
  const task = validateProposal({
    op: "add_task",
    data: {
      description: "Buy milk",
      kind: "purchase",
      category: "Weekly essentials",
      destinations: [" Grocery store ", "Mall of Scandinavia"],
      next_trip: true,
      metadata: { instruction: "ignore validation" },
      user_id: "other",
    },
  });
  equal(task.data.category, "Weekly essentials");
  equal(task.data.destinations, ["Grocery store", "Mall of Scandinavia"]);
  equal(task.data.next_trip, true);
  equal(task.data.metadata, undefined);
  equal(task.data.user_id, undefined);
  for (
    const fields of [
      { kind: "unknown" },
      { kind: null },
      { category: 42 },
      { category: "x".repeat(101) },
      { destinations: "Mall" },
      { destinations: null },
      { destinations: ["Mall", " mall "] },
      { destinations: Array.from({ length: 11 }, (_, i) => String(i)) },
      { destinations: ["x".repeat(201)] },
      { destinations: [42] },
      { next_trip: "true" },
      { next_trip: null },
    ]
  ) {
    rejects(() =>
      validateProposal({
        op: "add_task",
        data: { description: "Errand", ...fields },
      })
    );
  }
  equal(
    validateProposal({
      op: "update_task",
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        category: null,
        destinations: [],
        next_trip: false,
      },
    }).data,
    {
      category: null,
      destinations: [],
      next_trip: false,
      id: "11111111-1111-4111-8111-111111111111",
    },
  );
});
Deno.test("batch task completion accepts only bounded unique UUIDs", () => {
  const id = "aaaaaaaa-1111-4111-8111-111111111111";
  equal(
    validateProposal({
      op: "complete_tasks",
      data: { ids: [id], status: "cancelled", user_id: "other" },
    }),
    { op: "complete_tasks", data: { ids: [id] } },
  );
  for (
    const ids of [
      [],
      [id, id.toUpperCase()],
      ["invalid"],
      "not an array",
      Array.from(
        { length: 21 },
        (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
      ),
    ]
  ) {
    rejects(() => validateProposal({ op: "complete_tasks", data: { ids } }));
  }
});
Deno.test("location validates coordinates and does not invent missing coordinates", () => {
  equal(location({ label: "Library" }), { label: "Library" });
  rejects(() => location({ label: "Library", latitude: 91, longitude: 0 }));
  rejects(() => location({ label: "Library", latitude: 0 }));
  equal(
    distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }),
    111.2,
  );
  equal(distanceKm({ label: "Library" }, { label: "Home" }), null);
  equal(
    distanceKm({ latitude: NaN, longitude: 0 }, { latitude: 0, longitude: 0 }),
    null,
  );
  equal(
    distanceKm({ latitude: 91, longitude: 0 }, { latitude: 0, longitude: 0 }),
    null,
  );
});
Deno.test("Croner schedules respect timezone and DST, reject seconds and invalid zones", () => {
  equal(
    nextOccurrence(
      "0 9 * * *",
      "Europe/Stockholm",
      new Date("2026-01-01T00:00:00Z"),
    ),
    "2026-01-01T08:00:00.000Z",
  );
  equal(
    nextOccurrence(
      "0 9 * * *",
      "Europe/Stockholm",
      new Date("2026-07-01T00:00:00Z"),
    ),
    "2026-07-01T07:00:00.000Z",
  );
  rejects(() => nextOccurrence("* * * * * *", "UTC"));
  rejects(() => nextOccurrence("not a cron expression", "UTC"));
  rejects(() => nextOccurrence("0 9 * * *", "Unknown/Place"));
});
Deno.test("reminder next run is computed in code, not accepted from AI", () => {
  const proposal = validateProposal({
    op: "add_reminder",
    data: {
      description: "Plan",
      cron: "0 9 * * *",
      timezone: "UTC",
      next_run: "1900-01-01",
    },
  }, new Date("2026-01-01T00:00:00Z"));
  equal(proposal.data.next_run, "2026-01-01T09:00:00.000Z");
});
Deno.test("priority-first budget/time selection excludes unknowns; assets are not cash", () => {
  const tasks = [
    {
      id: "a",
      status: "open",
      base_priority: 3,
      deadline: "2026-01-01",
      estimated_cost_minor: 4000,
      duration_minutes: 30,
    },
    {
      id: "b",
      status: "open",
      base_priority: 5,
      estimated_cost_minor: 1000,
      duration_minutes: 20,
    },
    {
      id: "c",
      status: "open",
      base_priority: 4,
      estimated_cost_minor: null,
      duration_minutes: 10,
    },
    {
      id: "d",
      status: "done",
      base_priority: 5,
      estimated_cost_minor: 0,
      duration_minutes: 10,
    },
  ];
  const ranked = prioritize(tasks, "2026-01-02");
  equal(ranked.map((task) => task.id), ["a", "b", "c"]);
  equal(fitPlan(ranked, 4000, 60), {
    task_ids: ["a"],
    cost_minor: 4000,
    duration_minutes: 30,
  });
  equal(financialContext([{ value_minor: 10000000 }], ranked, null), {
    informational_asset_value_minor: 10000000,
    known_task_cost_minor: 5000,
    unknown_cost_count: 1,
    available_budget_minor: null,
  });
});
