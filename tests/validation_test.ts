import {
  InputError,
  nextOccurrence,
  validateProposal,
} from "../src/validation.ts";
import { prioritize, urgency } from "../src/planner/task-tracker.ts";

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
const id = "11111111-1111-4111-8111-111111111111";
Deno.test("add_task returns only the fixed task fields with defaults", () => {
  equal(
    validateProposal({
      op: "add_task",
      data: {
        name: " Groceries ",
        short_description: "Weekly food shopping",
        user_id: "other",
        status: "done",
        kind: "purchase",
        estimated_cost_minor: 100,
      },
    }),
    {
      op: "add_task",
      data: {
        name: "Groceries",
        short_description: "Weekly food shopping",
        location_name: null,
        priority: 3,
        due_date: null,
      },
    },
  );
  equal(
    validateProposal({
      op: "add_task",
      data: {
        name: "Car service",
        short_description: "Book BMW service",
        full_description: "Ask about the brakes too",
        location_name: "Garage",
        priority: 5,
        due_date: "2026-02-28",
      },
    }).data,
    {
      name: "Car service",
      short_description: "Book BMW service",
      full_description: "Ask about the brakes too",
      location_name: "Garage",
      priority: 5,
      due_date: "2026-02-28",
    },
  );
});
Deno.test("task fields are required and bounded", () => {
  const base = { name: "Errand", short_description: "Short" };
  rejects(() => validateProposal({ op: "run_sql", data: {} }));
  rejects(() => validateProposal({ op: "add_asset", data: base }));
  rejects(() => validateProposal({ op: "add_task", data: { name: "Errand" } }));
  rejects(() =>
    validateProposal({ op: "add_task", data: { short_description: "x" } })
  );
  rejects(() =>
    validateProposal({ op: "add_task", data: { ...base, name: " " } })
  );
  rejects(() =>
    validateProposal({
      op: "add_task",
      data: { ...base, name: "n".repeat(81) },
    })
  );
  rejects(() =>
    validateProposal({
      op: "add_task",
      data: { ...base, short_description: "s".repeat(161) },
    })
  );
  rejects(() =>
    validateProposal({
      op: "add_task",
      data: { ...base, full_description: "f".repeat(10001) },
    })
  );
  rejects(() =>
    validateProposal({
      op: "add_task",
      data: { ...base, location_name: "l".repeat(101) },
    })
  );
  rejects(() =>
    validateProposal({
      op: "add_task",
      data: { ...base, location_name: { label: "Home", latitude: 1 } },
    })
  );
  rejects(() =>
    validateProposal({ op: "add_task", data: { ...base, priority: 6 } })
  );
  rejects(() =>
    validateProposal({ op: "add_task", data: { ...base, priority: 2.5 } })
  );
  rejects(() =>
    validateProposal({
      op: "add_task",
      data: { ...base, due_date: "2026-02-30" },
    })
  );
  rejects(() =>
    validateProposal({ op: "update_task", data: { id, status: "unknown" } })
  );
  rejects(() =>
    validateProposal({ op: "delete_task", data: { id: "id&user_id=eq.other" } })
  );
  equal(
    validateProposal({
      op: "add_task",
      data: { ...base, short_description: "s".repeat(160) },
    }).data.short_description,
    "s".repeat(160),
  );
});
Deno.test("partial updates keep only changed fields", () => {
  equal(
    validateProposal({ op: "update_task", data: { id, priority: 1 } }),
    { op: "update_task", data: { priority: 1, id } },
  );
  equal(
    validateProposal({
      op: "update_task",
      data: { id, due_date: null, location_name: null, status: "done" },
    }).data,
    { location_name: null, due_date: null, status: "done", id },
  );
  rejects(() => validateProposal({ op: "update_task", data: { id } }));
  rejects(() =>
    validateProposal({
      op: "update_task",
      data: { id, full_description: "New detailed notes" },
    })
  );
  equal(
    validateProposal({
      op: "update_task",
      data: {
        id,
        full_description: "New detailed notes",
        short_description: "Updated notes",
      },
    }).data,
    {
      short_description: "Updated notes",
      full_description: "New detailed notes",
      id,
    },
  );
  equal(
    validateProposal({
      op: "set_profile",
      data: { preferences: "Mornings", currency: "SEK", budget_minor: 1 },
    }).data,
    { preferences: "Mornings" },
  );
  rejects(() =>
    validateProposal({ op: "set_profile", data: { currency: "SEK" } })
  );
});
Deno.test("batch task completion accepts only bounded unique UUIDs", () => {
  equal(
    validateProposal({ op: "complete_tasks", data: { ids: [id] } }).data,
    { ids: [id] },
  );
  rejects(() => validateProposal({ op: "complete_tasks", data: { ids: [] } }));
  rejects(() =>
    validateProposal({ op: "complete_tasks", data: { ids: [id, id] } })
  );
  rejects(() =>
    validateProposal({
      op: "complete_tasks",
      data: { ids: Array.from({ length: 21 }, () => crypto.randomUUID()) },
    })
  );
});
Deno.test("urgency and priority ordering are calculated in code", () => {
  const today = "2026-01-10";
  equal(urgency(null, today), "none");
  equal(urgency("2026-01-09", today), "overdue");
  equal(urgency(today, today), "today");
  equal(urgency("2026-01-13", today), "soon");
  equal(urgency("2026-01-14", today), "later");
  equal(urgency("2026-02-01", "2026-01-30"), "soon");
  const ranked = prioritize([
    { id: "a", status: "open", priority: 3, created_at: "2026-01-01" },
    { id: "b", status: "open", priority: 1, due_date: "2026-01-09" },
    { id: "c", status: "open", priority: 3, due_date: "2026-01-12" },
    { id: "d", status: "done", priority: 5 },
    { id: "e", status: "open", priority: 3, created_at: "2025-12-31" },
    { id: "f", status: "open", priority: 5, due_date: "2026-01-20" },
  ], today);
  equal(ranked.map((task) => task.id), ["b", "c", "f", "e", "a"]);
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

Deno.test("reminder updates validate schedule, state, and target", () => {
  equal(
    validateProposal({
      op: "update_reminder",
      data: {
        id,
        description: "Weekly planning",
        cron: "0 18 * * 1",
        timezone: "Europe/Stockholm",
        active: false,
        next_run: "model-controlled",
      },
    }),
    {
      op: "update_reminder",
      data: {
        id,
        description: "Weekly planning",
        cron: "0 18 * * 1",
        timezone: "Europe/Stockholm",
        active: false,
      },
    },
  );
  rejects(() =>
    validateProposal({
      op: "update_reminder",
      data: { id, active: "false" },
    })
  );
  rejects(() =>
    validateProposal({
      op: "update_reminder",
      data: { id, cron: "not a schedule", timezone: "UTC" },
    })
  );
  rejects(() => validateProposal({ op: "update_reminder", data: { id } }));
});
