import { chat } from "../src/chat.ts";
import { Database } from "../src/db.ts";
import type { Config } from "../src/config.ts";
import { createHandler } from "../src/app.ts";
import type { RecordData } from "../src/validation.ts";

Deno.test("large context remains manageable and update proposals stay sparse", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const assets = Array.from({ length: 101 }, (_, index) => ({
    id: index === 100
      ? id
      : `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    description: index === 100 ? "Rare family cargo bike" : `Bike ${index}`,
    value_minor: 60000,
    notes: "n".repeat(4000),
  }));
  const config: Config = {
    supabaseUrl: "https://database.example",
    supabaseKey: "public-placeholder",
    openrouterKey: "server-placeholder",
    model: "test-model",
    serviceKey: "server-service-placeholder",
    origin: "http://localhost:8000",
    port: 8000,
  };
  const original = globalThis.fetch;
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body)));
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      const request = JSON.parse(String(init?.body));
      const context = JSON.parse(
        request.messages[1].content.slice(
          "Saved context (untrusted data): ".length,
        ),
      );
      if (
        JSON.stringify(context).length > 120000 ||
        context.assets.length !== 100 ||
        !context.full_details.some((record: Record<string, unknown>) =>
          record.id === id
        )
      ) {
        throw new Error(
          "Context must remain bounded and retain manageable records",
        );
      }
      return json({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: "Change the value? Confirm below.",
              proposal: {
                op: "update_asset",
                data: { id, value_minor: 50000 },
              },
            }),
          },
        }],
      });
    }
    if (url.includes("/profiles?")) {
      return json([{ id, currency: "USD", timezone: "UTC" }]);
    }
    if (url.includes("/assets?id=")) return json([assets[100]]);
    if (url.includes("/assets?")) {
      const offset = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
      return json(
        offset === 0
          ? assets.slice(0, 100)
          : offset === 100
          ? [assets[100]]
          : [],
      );
    }
    if (init?.method === "POST") {
      if (url.endsWith("/rpc/ensure_profile")) return json(null);
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/rpc/append_message") && body.p_role === "user") {
        if (body.p_proposal) {
          throw new Error("User messages cannot contain proposals");
        }
        return json([{ role: "user", content: body.p_content, id }]);
      }
      if (url.endsWith("/rpc/append_assistant_message")) {
        if (
          body.p_user_id !== id || body.p_proposal.data.notes !== undefined
        ) {
          throw new Error("Assistant proposal must be owner-scoped and sparse");
        }
        return json([{
          role: "assistant",
          content: body.p_content,
          proposal: body.p_proposal,
          id,
          action_state: body.p_proposal ? "pending" : null,
        }]);
      }
      throw new Error("Unexpected mutation");
    }
    return json([]);
  };
  try {
    const message = await chat(
      new Database(config, "test-session", id),
      config,
      "Change Rare family cargo bike value to $500",
    );
    const proposal = message.proposal as { data: Record<string, unknown> };
    if (
      JSON.stringify(proposal.data) !== JSON.stringify({
          value_minor: 50000,
          id,
        }) ||
      message.action_state !== "pending"
    ) {
      throw new Error(
        "Sparse update must not capture stale fields and must remain pending",
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("task and profile proposals retain only explicitly changed fields", async () => {
  const taskId = "11111111-1111-4111-8111-111111111111";
  const profile = {
    id: taskId,
    timezone: "UTC",
    currency: "USD",
    starting_location: { label: "Home", latitude: 1, longitude: 2 },
    preferences: "saved preference",
    budget_minor: 24000,
  };
  const task = {
    id: taskId,
    description: "Library books",
    location: { label: "Library" },
    base_priority: 3,
    estimated_cost_minor: 500,
    duration_minutes: 25,
    deadline: "2026-10-10",
    status: "open",
  };
  const cases = [
    {
      prompt: "Raise the library task priority",
      output: {
        op: "update_task",
        data: { id: taskId, base_priority: 5 },
      },
      expected: {
        op: "update_task",
        data: { base_priority: 5, id: task.id },
      },
    },
    {
      prompt: "Change my preferences",
      output: { op: "set_profile", data: { preferences: "new preference" } },
      expected: {
        op: "set_profile",
        data: { preferences: "new preference" },
      },
    },
  ];
  const config: Config = {
    supabaseUrl: "https://database.example",
    supabaseKey: "public-placeholder",
    openrouterKey: "server-placeholder",
    model: "test-model",
    serviceKey: "server-service-placeholder",
    origin: "http://localhost:8000",
    port: 8000,
  };
  const original = globalThis.fetch;
  try {
    for (const testCase of cases) {
      globalThis.fetch = (input, init) => {
        const url = String(input);
        const json = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body)));
        if (url.includes("openrouter.ai")) {
          return json({
            choices: [{
              message: {
                content: JSON.stringify({
                  reply: "Confirm this change?",
                  proposal: testCase.output,
                }),
              },
            }],
          });
        }

        if (url.includes("/profiles?")) return json([profile]);
        if (url.includes("/tasks?id=")) return json([task]);
        if (url.includes("/tasks?")) return json([task]);
        if (
          url.includes("/assets?") || url.includes("/reminders?") ||
          url.includes("/messages?")
        ) {
          return json([]);
        }
        if (init?.method === "POST") {
          if (url.endsWith("/rpc/ensure_profile")) return json(null);
          const body = JSON.parse(String(init.body));
          if (url.endsWith("/rpc/append_message")) {
            if (body.p_role === "user") {
              return json([{
                id: taskId,
                role: "user",
                content: body.p_content,
              }]);
            }
          }
          if (url.endsWith("/rpc/append_assistant_message")) {
            const proposal = {
              ...testCase.expected,
              currency: "USD",
            };
            if (
              body.p_user_id !== taskId ||
              JSON.stringify(body.p_proposal) !== JSON.stringify(proposal)
            ) {
              throw new Error("Update proposal must remain sparse");
            }
            return json([{
              id: taskId,
              proposal,
              action_state: "pending",
            }]);
          }
        }
        throw new Error(`Unexpected request: ${url}`);
      };
      const message = await chat(
        new Database(config, "test-session", taskId),
        config,
        testCase.prompt,
      );
      if (
        message.action_state !== "pending" ||
        JSON.stringify(message.proposal) !== JSON.stringify({
            ...testCase.expected,
            currency: "USD",
          })
      ) {
        throw new Error("Sparse proposal should remain pending confirmation");
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("calculated plan text stays within the database message limit", async () => {
  const owner = "11111111-1111-4111-8111-111111111111";
  const tasks = Array.from({ length: 100 }, (_, index) => ({
    id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    description: `Task ${index} ${"x".repeat(994 - String(index).length)}`,
    status: "open",
    base_priority: 3,
    estimated_cost_minor: 0,
    duration_minutes: 1,
  }));
  const config: Config = {
    supabaseUrl: "https://database.example",
    supabaseKey: "public-placeholder",
    openrouterKey: "server-placeholder",
    model: "test-model",
    serviceKey: "server-service-placeholder",
    origin: "http://localhost:8000",
    port: 8000,
  };
  const original = globalThis.fetch;
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body)));
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      return json({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: "r".repeat(10000),
              plan_constraints: { budget_minor: 0, minutes: 1440 },
            }),
          },
        }],
      });
    }
    if (url.includes("/profiles?")) {
      return json([{ id: owner, timezone: "UTC", currency: "USD" }]);
    }
    if (url.includes("/tasks?")) {
      const offset = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
      return json(offset === 0 ? tasks : []);
    }
    if (url.endsWith("/rpc/ensure_profile")) return json(null);
    if (url.endsWith("/rpc/record_plan")) return json([]);
    if (url.endsWith("/rpc/append_message")) {
      return json([{ role: "user", content: "Plan today", id: owner }]);
    }
    if (url.endsWith("/rpc/append_assistant_message")) {
      const body = JSON.parse(String(init?.body));
      if (
        body.p_content.length > 20000 ||
        !body.p_content.includes("and 80 more") ||
        !body.p_content.includes(tasks[0].description.slice(0, 100)) ||
        body.p_content.includes(tasks[0].description.slice(0, 101))
      ) {
        throw new Error("Plan response exceeded its bounded display");
      }
      return json([{ role: "assistant", content: body.p_content, id: owner }]);
    }
    if (
      url.includes("/assets?") || url.includes("/reminders?") ||
      url.includes("/messages?")
    ) return json([]);
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    await chat(
      new Database(config, "test-session", owner),
      config,
      "Plan today's tasks",
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("informal task requests use generic validated context and deterministic list/completion paths", async () => {
  const owner = "11111111-1111-4111-8111-111111111111";
  const milkId = "22222222-2222-4222-8222-222222222222";
  const routerId = "33333333-3333-4333-8333-333333333333";
  const tasks: RecordData[] = [
    {
      id: milkId,
      description: "Buy milk",
      kind: "purchase",
      category: "Groceries",
      status: "open",
      base_priority: 3,
      destinations: ["Grocery store"],
      estimated_cost_minor: null,
      duration_minutes: null,
    },
    {
      id: routerId,
      description: "Buy a new router",
      kind: "purchase",
      category: "Electronics",
      status: "open",
      base_priority: 3,
      destinations: ["Shopping centre"],
      next_trip: true,
      estimated_cost_minor: 50000,
      duration_minutes: 30,
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      description: "Service BMW",
      kind: "task",
      status: "open",
      base_priority: 4,
      estimated_cost_minor: null,
      duration_minutes: null,
    },
    {
      id: "55555555-5555-4555-8555-555555555555",
      description: "Buy bread",
      kind: "purchase",
      status: "done",
    },
  ];
  const config: Config = {
    supabaseUrl: "https://database.example",
    supabaseKey: "public-placeholder",
    openrouterKey: "server-placeholder",
    model: "test-model",
    serviceKey: "server-service-placeholder",
    origin: "http://localhost:8000",
    port: 8000,
  };
  const cases: {
    prompt: string;
    output: RecordData;
    check: (message: RecordData) => void;
    extra?: RecordData;
    status?: number;
  }[] = [
    {
      prompt: "remember that i shoukd buy milk",
      output: {
        proposal: {
          op: "add_task",
          data: {
            description: "Buy milk",
            kind: "purchase",
            category: "Groceries",
          },
        },
      },
      check: (message) => {
        const proposal = message.proposal as {
          op: string;
          data: RecordData;
        };
        assert(proposal.op === "add_task");
        assert(
          proposal.data.kind === "purchase" &&
            proposal.data.deadline === null,
        );
        assert(proposal.data.estimated_cost_minor === null);
        assert(message.action_state === "pending");
      },
    },
    {
      prompt: "give me a shopping list, i'm going to the grocery store",
      output: {
        task_query: { kind: "purchase", destination: "Grocery store" },
      },
      check: (message) => {
        const content = String(message.content);
        assert(
          content.includes("Buy milk") &&
            content.includes("Buy a new router"),
        );
        assert(!content.includes("bread") && !content.includes("BMW"));
        assert(
          content.indexOf("Buy milk") <
            content.indexOf("Destination not established"),
        );
        assert(message.proposal === null);
      },
    },
    {
      prompt:
        "rememeber that i shoukd by a new router on next trip to the shopping centre",
      output: {
        proposal: {
          op: "add_task",
          data: {
            description: "Buy a new router",
            kind: "purchase",
            category: "Electronics",
            destinations: ["Shopping centre"],
            next_trip: true,
          },
        },
      },
      check: (message) => {
        const proposal = message.proposal as {
          op: string;
          data: RecordData;
        };
        assert(
          proposal.op === "add_task" && proposal.data.next_trip === true,
        );
        assert(
          proposal.data.deadline === null &&
            proposal.data.cron === undefined,
        );
      },
    },
    {
      prompt:
        "i'm going to the shopping centre, anything on the shopping list?",
      output: {
        task_query: { kind: "purchase", destination: "Shopping centre" },
      },
      check: (message) => {
        const content = String(message.content);
        assert(
          content.indexOf("Buy a new router") <
            content.indexOf("Destination not established"),
        );
        assert(
          content.indexOf("Buy milk") >
            content.indexOf("Destination not established"),
        );
      },
    },
    {
      prompt: "Ive bought milk and a router",
      output: {
        proposal: {
          op: "complete_tasks",
          data: { items: ["milk", "router"] },
        },
      },
      check: (message) => {
        const proposal = message.proposal as {
          op: string;
          data: RecordData;
        };
        assert(proposal.op === "complete_tasks");
        assert(
          JSON.stringify(proposal.data.ids) ===
            JSON.stringify([milkId, routerId]),
        );
        assert(message.action_state === "pending");
        assert(
          String(message.content).includes("Nothing has been changed"),
        );
      },
    },
    {
      prompt: "Ive bought milk and a router",
      extra: {
        ...tasks[0],
        id: "66666666-6666-4666-8666-666666666666",
        description: "Buy oat milk",
      },
      output: {
        proposal: {
          op: "complete_tasks",
          data: { items: ["milk", "router"] },
        },
      },
      check: (message) => {
        assert(
          message.proposal === null && message.action_state === null,
        );
        assert(String(message.content).includes("Which task"));
      },
    },
    {
      prompt: "what on my shopping list is available in mall of scandinavia",
      output: {
        reply: "Milk and routers are definitely in stock!",
        task_query: {
          kind: "purchase",
          destination: "Mall of Scandinavia",
        },
      },
      check: (message) => {
        const content = String(message.content);
        assert(!content.includes("definitely in stock"));
        assert(content.includes("Saved destination matches:\nNone."));
        assert(
          content.includes(
            "cannot verify stores, stock, or opening hours",
          ),
        );
      },
    },
    {
      prompt: "the bmw needs service",
      output: {
        proposal: {
          op: "add_task",
          data: {
            description: "Service BMW",
            kind: "task",
            category: "Vehicle maintenance",
            location: {
              label: "Garage",
              latitude: 59.3,
              longitude: 18.1,
            },
          },
        },
      },
      check: (message) => {
        const proposal = message.proposal as {
          op: string;
          data: RecordData;
        };
        assert(
          proposal.op === "add_task" && proposal.data.kind === "task",
        );
        assert((proposal.data.location as RecordData).latitude === 59.3);
        assert(proposal.data.estimated_cost_minor === null);
      },
    },
    {
      prompt:
        "plan my day based on stuff that needs to be done, 600 SEK and 60 minutes",
      output: { plan_constraints: { budget_minor: 60000, minutes: 60 } },
      check: (message) => {
        const content = String(message.content);
        assert(content.includes("Cost: 50000 minor units (SEK)"));
        assert(
          content.includes(
            "Needs estimates (not included in calculated totals)",
          ),
        );
        assert(content.includes("Buy milk (missing cost and duration)"));
        assert(
          content.includes("Service BMW (missing cost and duration)"),
        );
        assert(!content.includes("bread"));
      },
    },
    {
      prompt:
        "Fill my day with tasks, including a visit to copenhagen, 600 SEK and 60 minutes",
      extra: {
        id: "77777777-7777-4777-8777-777777777777",
        description: "Return a parcel",
        kind: "task",
        status: "open",
        destinations: ["Copenhagen"],
        base_priority: 5,
        estimated_cost_minor: 0,
        duration_minutes: 15,
      },
      output: {
        plan_constraints: { budget_minor: 60000, minutes: 60 },
        plan_context: {
          destination: "Copenhagen",
          suggested_task_ids: [milkId],
        },
      },
      check: (message) => {
        const content = String(message.content);
        assert(
          content.includes(
            "Calculated priority-first plan: Return a parcel",
          ),
        );
        assert(content.includes("Visit context: Copenhagen"));
        assert(
          content.includes(
            "AI-suggested possibilities, not verified for this destination: Buy milk",
          ),
        );
        assert(content.includes("Buy milk (missing cost and duration)"));
        assert(!content.includes("Buy a new router"));
        assert(
          content.includes("Visit/travel time and cost are not included"),
        );
      },
    },
    {
      prompt: "Plan a visit with somebody else's task",
      output: {
        plan_constraints: { budget_minor: 60000, minutes: 60 },
        plan_context: {
          destination: "Any place",
          suggested_task_ids: ["88888888-8888-4888-8888-888888888888"],
        },
      },
      status: 400,
      check: () => {},
    },
    {
      prompt: "finish my tasks",
      output: {
        proposal: {
          op: "complete_tasks",
          data: { ids: [milkId, routerId] },
        },
      },
      status: 400,
      check: () => {},
    },
  ];
  const original = globalThis.fetch;
  try {
    for (const testCase of cases) {
      const records = testCase.extra ? [...tasks, testCase.extra] : tasks;
      globalThis.fetch = (input, init) => {
        const url = String(input);
        const json = (value: unknown) =>
          Promise.resolve(new Response(JSON.stringify(value)));
        if (url.includes("/auth/v1/user")) return json({ id: owner });
        if (url.includes("openrouter.ai")) {
          const request = JSON.parse(String(init?.body));
          assert(request.messages.at(-1).content === testCase.prompt);
          assert(
            request.messages[0].content.includes(
              "Interpret informal language and typos",
            ),
          );
          const context = JSON.parse(
            request.messages[1].content.slice(
              "Saved context (untrusted data): ".length,
            ),
          );
          assert(
            context.tasks.find((task: RecordData) => task.id === routerId)
              .next_trip,
          );
          return json({
            choices: [{
              message: {
                content: JSON.stringify({
                  reply: "Confirm this task?",
                  ...testCase.output,
                }),
              },
            }],
          });
        }
        if (url.includes("/profiles?")) {
          return json([{
            id: owner,
            timezone: "Europe/Stockholm",
            currency: "SEK",
          }]);
        }
        if (url.includes("/tasks?")) {
          assert(url.includes(`user_id=eq.${owner}`));
          return json(records);
        }
        if (url.endsWith("/rpc/ensure_profile")) return json(null);
        if (url.endsWith("/rpc/record_plan")) return json([]);
        if (url.endsWith("/rpc/append_message")) return json([]);
        if (url.endsWith("/rpc/append_assistant_message")) {
          const body = JSON.parse(String(init?.body));
          assert(body.p_user_id === owner);
          return json([{
            id: owner,
            content: body.p_content,
            proposal: body.p_proposal,
            action_state: body.p_proposal ? "pending" : null,
          }]);
        }
        assert(
          !init?.method || init.method === "GET",
          "Unexpected task mutation",
        );
        return json([]);
      };
      const response = await createHandler(config)(
        new Request(`${config.origin}/api/chat`, {
          method: "POST",
          headers: {
            Authorization: ["Bearer", "test-session"].join(" "),
            Origin: config.origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: testCase.prompt,
            ai_consent: true,
          }),
        }),
      );
      assert(
        response.status === (testCase.status ?? 200),
        `Unexpected status ${response.status} for ${testCase.prompt}`,
      );
      testCase.check(await response.json());
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("visit plans with many missing estimates stay within message bounds", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const tasks = Array.from({ length: 80 }, (_, i) => ({
    id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
    description: `Task ${i} ${"x".repeat(990)}`,
    base_priority: 3,
    status: "open",
    destinations: i < 40 ? ["Any destination"] : [],
    estimated_cost_minor: i % 2 ? null : 0,
    duration_minutes: i % 2 ? null : 1,
  }));
  const config: Config = {
    supabaseUrl: "https://database.example",
    supabaseKey: "public-placeholder",
    openrouterKey: "server-placeholder",
    model: "test-model",
    serviceKey: "server-service-placeholder",
    origin: "http://localhost:8000",
    port: 8000,
  };
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body)));
    if (url.includes("openrouter.ai")) {
      return json({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: "r".repeat(10000),
              plan_constraints: { budget_minor: 0, minutes: 1440 },
              plan_context: {
                destination: "Any destination",
                suggested_task_ids: tasks.slice(40).map((task) => task.id),
              },
            }),
          },
        }],
      });
    }
    if (url.includes("/profiles?")) {
      return json([{ id, currency: "USD", timezone: "UTC" }]);
    }
    if (url.includes("/tasks?")) return json(tasks);
    if (url.endsWith("/rpc/append_assistant_message")) {
      const body = JSON.parse(String(init?.body));
      assert(body.p_content.length <= 20000);
      assert(body.p_content.includes("Needs estimates"));
      assert(
        body.p_content.includes("Visit/travel time and cost are not included"),
      );
      return json([{ content: body.p_content }]);
    }
    return json([]);
  };
  try {
    await chat(
      new Database(config, "test-session", id),
      config,
      "Plan my visit",
    );
  } finally {
    globalThis.fetch = original;
  }
});

function assert(
  value: unknown,
  message = "Assertion failed",
): asserts value {
  if (!value) throw new Error(message);
}
