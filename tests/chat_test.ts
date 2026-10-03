import { chat } from "../src/chat.ts";
import { Database } from "../src/db.ts";
import type { Config } from "../src/config.ts";

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
      if (request.plugins !== undefined) {
        throw new Error("Online search must be opt-in");
      }
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
