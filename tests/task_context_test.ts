import {
  detailPrefix,
  resolveCompletion,
  resolveReferences,
  taskDetail,
  taskList,
} from "../src/planner/task-context.ts";
import { groupByLocation } from "../src/planner/geo-planner.ts";
import { InputError, type RecordData } from "../src/validation.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
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
const today = "2026-01-10";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tasks: RecordData[] = [
  {
    id: id(1),
    name: "Milk",
    short_description: "Buy oat milk",
    location_name: "ICA",
    priority: 3,
    due_date: "2026-01-10",
    status: "open",
  },
  {
    id: id(2),
    name: "Router",
    short_description: "Buy a new wifi router",
    location_name: "ica ",
    priority: 2,
    due_date: null,
    status: "open",
  },
  {
    id: id(3),
    name: "Car service",
    short_description: "Book BMW service",
    location_name: null,
    priority: 4,
    due_date: "2026-01-05",
    status: "open",
  },
  {
    id: id(4),
    name: "Milk powder",
    short_description: "For the baby",
    location_name: "Pharmacy",
    priority: 3,
    due_date: "2026-03-01",
    status: "open",
  },
  {
    id: id(5),
    name: "Library books",
    short_description: "Return books",
    location_name: "Library",
    priority: 3,
    due_date: null,
    status: "done",
  },
];

Deno.test("location lists filter case-insensitively from saved open tasks", () => {
  const list = taskList(tasks, { location_name: "Ica" }, today);
  assert(list.includes("Open tasks (at Ica): 2"), list);
  assert(list.includes("Milk — Buy oat milk") && list.includes("Router"));
  assert(!list.includes("Car service") && !list.includes("Library"));
});

Deno.test("unfiltered lists are grouped by location with unlocated tasks last", () => {
  const list = taskList(tasks, {}, today);
  assert(list.indexOf("ICA:") < list.indexOf("Pharmacy:"), list);
  assert(list.indexOf("Pharmacy:") < list.indexOf("No location:"), list);
  assert(!list.includes("Library books"));
  const groups = groupByLocation(tasks.slice(0, 3));
  assert(groups.length === 2 && groups[0].tasks.length === 2);
});

Deno.test("urgency and status filters use code-calculated urgency", () => {
  const urgent = taskList(
    tasks,
    { urgency: ["overdue", "today", "soon"] },
    today,
  );
  assert(urgent.includes("Milk —") && urgent.includes("Car service"), urgent);
  assert(!urgent.includes("Router") && !urgent.includes("Milk powder"));
  assert(urgent.includes("(overdue)") && urgent.includes("(today)"));
  const done = taskList(tasks, { status: "done" }, today);
  assert(done.includes("Library books") && !done.includes("Milk"));
  rejects(() => taskList(tasks, { urgency: ["urgent"] }, today));
  rejects(() => taskList(tasks, { status: "archived" }, today));
});

Deno.test("references resolve by exact name or ID and never guess", () => {
  const exact = resolveReferences(tasks, ["milk"]);
  assert(exact.ids?.[0] === id(1), "Exact name wins over partial matches");
  assert(resolveReferences(tasks, [id(4)]).ids?.[0] === id(4));
  const ambiguous = resolveReferences(
    [...tasks, { ...tasks[0], id: id(6), name: "Milk chocolate" }]
      .filter((task) => task.id !== id(1)),
    ["milk"],
  );
  assert(
    ambiguous.ids === null && ambiguous.clarification.includes("Which task"),
  );
  const missing = resolveReferences(tasks, ["Lawn"]);
  assert(missing.ids === null && missing.clarification.includes("couldn't"));
  const batch = resolveCompletion(tasks, { items: ["Milk", "Router"] });
  assert(batch.ids?.join() === [id(1), id(2)].join());
  const finished = resolveCompletion(tasks, { items: ["Library books"] });
  assert(finished.ids === null, "Completion only resolves open tasks");
  const twice = resolveCompletion(tasks, { items: ["Milk", id(1)] });
  assert(twice.ids === null);
  rejects(() => resolveCompletion(tasks, { items: [] }));
});

Deno.test("task details show the saved full description as text", () => {
  const detail = taskDetail({
    ...tasks[2],
    full_description: "Ask about <b>brakes</b>",
    created_at: "2026-01-01T10:00:00Z",
  }, today);
  assert(detail.startsWith(detailPrefix));
  assert(detail.includes("Full description:\nAsk about <b>brakes</b>"));
  assert(detail.includes("created 2026-01-01"));
  assert(taskDetail(tasks[0], today).includes("No full description saved."));
});
