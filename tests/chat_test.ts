import { chat } from "../src/chat.ts";
import { Database } from "../src/db.ts";
import type { Config } from "../src/config.ts";

Deno.test("large context remains manageable and partial updates preserve unmodified notes", async () => {
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
        JSON.stringify(context).length > 120000 || context.assets.length !== 100 ||
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
      return json(offset === 0 ? assets.slice(0, 100) : offset === 100
        ? [assets[100]]
        : []);
    }
    if (init?.method === "POST") {
      if (url.endsWith("/rpc/ensure_profile")) return json(null);
      if (!url.endsWith("/rpc/append_message")) {
        throw new Error("Unexpected mutation");
      }
      const body = JSON.parse(String(init.body));
      return json([{
        role: body.p_role,
        content: body.p_content,
        proposal: body.p_proposal,
        id,
        action_state: body.p_proposal ? "pending" : null,
      }]);
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
      proposal.data.notes !== assets[100].notes ||
      proposal.data.description !== assets[100].description ||
      proposal.data.value_minor !== 50000 || message.action_state !== "pending"
    ) {
      throw new Error(
        "Partial update lost saved fields or bypassed confirmation",
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("sparse task and profile updates preserve saved fields pending confirmation", async () => {
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
        data: {
          description: task.description,
          location: task.location,
          base_priority: 5,
          estimated_cost_minor: task.estimated_cost_minor,
          duration_minutes: task.duration_minutes,
          deadline: task.deadline,
          status: task.status,
          id: task.id,
        },
      },
    },
    {
      prompt: "Change my preferences",
      output: { op: "set_profile", data: { preferences: "new preference" } },
      expected: {
        op: "set_profile",
        data: {
          timezone: profile.timezone,
          currency: profile.currency,
          starting_location: profile.starting_location,
          preferences: "new preference",
          budget_minor: profile.budget_minor,
        },
      },
    },
  ];
  const config: Config = {
    supabaseUrl: "https://database.example",
    supabaseKey: "public-placeholder",
    openrouterKey: "server-placeholder",
    model: "test-model",
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
        if (url.includes("/assets?") || url.includes("/tasks?") ||
          url.includes("/reminders?") || url.includes("/messages?")) {
          return json([]);
        }
        if (init?.method === "POST") {
          if (url.endsWith("/rpc/ensure_profile")) return json(null);
          const body = JSON.parse(String(init.body));
          if (url.endsWith("/rpc/append_message")) {
            if (body.p_role === "user") {
              return json([{ id: taskId, role: "user", content: body.p_content }]);
            }
            const proposal = {
              ...testCase.expected,
              currency: "USD",
            };
            if (
              JSON.stringify(body.p_proposal) !== JSON.stringify(proposal)
            ) {
              throw new Error("Sparse update did not preserve saved fields");
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
        throw new Error("Proposal should remain pending with merged fields");
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});
