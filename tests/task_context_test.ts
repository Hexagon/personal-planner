import {
  resolveCompletion,
  taskList,
  visitPlanContext,
} from "../src/planner/task-context.ts";
import { InputError, type RecordData } from "../src/validation.ts";

function assert(value: unknown) {
  if (!value) throw new Error("Assertion failed");
}
const milk = {
  id: "11111111-1111-4111-8111-111111111111",
  description: "Buy milk",
  kind: "purchase",
  category: "Groceries",
  status: "open",
  destinations: ["Grocery store"],
};
const router = {
  id: "22222222-2222-4222-8222-222222222222",
  description: "Buy a new router",
  kind: "purchase",
  category: "Electronics",
  status: "open",
  destinations: ["Shopping centre"],
  next_trip: true,
};
const service = {
  id: "33333333-3333-4333-8333-333333333333",
  description: "Service BMW",
  kind: "task",
  category: "Vehicle maintenance",
  status: "open",
  location: { label: "Garage", latitude: 59.3, longitude: 18.1 },
};
const tasks: RecordData[] = [
  milk,
  router,
  service,
  { ...milk, id: "done", description: "Bought bread", status: "done" },
  { ...milk, id: "cancelled", description: "Buy cheese", status: "cancelled" },
];

Deno.test("shopping retrieval selects open purchases and generic categories", () => {
  const list = taskList(tasks, { kind: "purchase" });
  assert(list.includes("Buy milk") && list.includes("Buy a new router"));
  assert(
    !list.includes("BMW") && !list.includes("bread") &&
      !list.includes("cheese"),
  );
  const category = taskList(tasks, { category: "vehicle maintenance" });
  assert(category.includes("Service BMW") && !category.includes("milk"));
});
Deno.test("saved destination matches are separate from unverified availability", () => {
  const list = taskList(tasks, {
    kind: "purchase",
    destination: " shopping CENTRE ",
  });
  assert(
    list.indexOf("Buy a new router") <
      list.indexOf("Destination not established"),
  );
  assert(
    list.indexOf("Buy milk") > list.indexOf("Destination not established"),
  );
  assert(list.includes("next trip; no timed reminder"));
  const mall = taskList(tasks, {
    kind: "purchase",
    destination: "Mall of Scandinavia",
  });
  assert(mall.includes("Saved destination matches:\nNone."));
  assert(mall.includes("cannot verify stores, stock, or opening hours"));
  assert(mall.includes("Buy milk") && mall.includes("Buy a new router"));
  const garage = taskList(tasks, { destination: "Garage" });
  assert(
    garage.indexOf("Service BMW") <
      garage.indexOf("Destination not established"),
  );
});
Deno.test("batch references resolve all open tasks without partial or guessed matches", () => {
  const completion = resolveCompletion(tasks, { items: ["milk", "router"] });
  assert(
    JSON.stringify(completion.ids) === JSON.stringify([milk.id, router.id]),
  );
  assert(resolveCompletion(tasks, { items: ["BMW"] }).ids?.[0] === service.id);
  assert(resolveCompletion(tasks, { items: ["bread"] }).ids === null);
  assert(resolveCompletion(tasks, { items: ["milk", "missing"] }).ids === null);
  assert(resolveCompletion(tasks, { items: ["milk", milk.id] }).ids === null);
  assert(
    resolveCompletion([
      ...tasks,
      { ...milk, id: "other", description: "Buy oat milk" },
    ], { items: ["milk", "router"] }).clarification?.includes("Which task"),
  );
  assert(resolveCompletion(tasks, { items: ["silk"] }).ids === null);
});
Deno.test("large task lists retain bounds without falsely reporting no uncertain items", () => {
  const many = Array.from({ length: 101 }, (_, i) => ({
    ...milk,
    id: String(i),
    description: `Item ${i}`,
  }));
  many.push({ ...milk, id: "other", description: "Unknown", destinations: [] });
  const list = taskList(many, { destination: "Grocery store" });
  assert(!list.includes("Item 100"));
  assert(list.includes("Additional items omitted"));
});

Deno.test("visit planning combines saved matches with AI possibilities for any destination", () => {
  const local = {
    ...service,
    description: "Return a parcel",
    destinations: ["Copenhagen"],
    location: null,
  };
  const records = [local, milk, router];
  for (const destination of ["Copenhagen", "Somewhere else"]) {
    const context = visitPlanContext(records, {
      destination,
      suggested_task_ids: [milk.id],
    });
    assert(context.tasks.some((task) => task.id === milk.id));
    assert(
      context.tasks.some((task) => task.id === local.id) ===
        (destination === "Copenhagen"),
    );
    assert(!context.tasks.some((task) => task.id === router.id));
    assert(
      context.summary.includes("AI-suggested possibilities, not verified"),
    );
    assert(
      context.summary.includes("Visit/travel time and cost are not included"),
    );
  }
});
Deno.test("coordinate proximity uses validated generic destinations and explicit radii", () => {
  const nearby = {
    ...service,
    location: { label: "Parcel counter", latitude: 55.677, longitude: 12.569 },
  };
  const far = {
    ...router,
    location: { label: "Copenhagen", latitude: 59.3, longitude: 18.1 },
  };
  const destination = { label: "Visit", latitude: 55.676, longitude: 12.568 };
  const context = visitPlanContext([nearby, far], {
    destination,
    radius_km: 2,
  });
  assert(context.tasks.length === 1 && context.tasks[0].id === nearby.id);
  assert(
    visitPlanContext([{ ...milk, destinations: ["Visit"] }], {
      destination,
      radius_km: 2,
    }).tasks.length === 0,
  );
  const list = taskList([nearby, far], { destination, radius_km: 2 });
  assert(
    list.indexOf("Service BMW") < list.indexOf("Destination not established"),
  );
  assert(
    list.indexOf("Buy a new router") >
      list.indexOf("Destination not established"),
  );
  for (
    const query of [
      { destination, radius_km: -1 },
      { destination, radius_km: Infinity },
      { destination, radius_km: 1001 },
      { destination, radius_km: "2" },
      { destination: "Copenhagen", radius_km: 2 },
      { destination: { label: "Visit", latitude: 91, longitude: 0 } },
      { destination, suggested_task_ids: [milk.id] },
      { destination, suggested_task_ids: [nearby.id, nearby.id] },
      { destination, suggested_task_ids: ["invalid"] },
    ]
  ) {
    try {
      visitPlanContext([nearby, far], query);
      throw new Error("Invalid context accepted");
    } catch (error) {
      assert(error instanceof InputError);
    }
  }
});
