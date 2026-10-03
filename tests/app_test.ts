import { createHandler } from "../src/app.ts";
import { Database } from "../src/db.ts";
import type { Config } from "../src/config.ts";
import { startScheduler } from "../src/scheduler.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const config: Config = {
  supabaseUrl: "https://database.example",
  supabaseKey: "public-placeholder",
  openrouterKey: "server-placeholder",
  model: "test-model",
  origin: "http://localhost:8000",
  port: 8000,
};
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function request(path: string, body?: unknown, origin = config.origin) {
  return new Request(`${config.origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: ["Bearer", "test-session"].join(" "),
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function mock(callback: typeof fetch, test: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = callback;
  try {
    await test();
  } finally {
    globalThis.fetch = original;
  }
}
Deno.test("public config never leaks server credentials; unauthorized and cross-origin requests fail", async () => {
  const handler = createHandler({
    ...config,
    serviceKey: "privileged-placeholder",
  });
  const publicConfig =
    await (await handler(new Request(`${config.origin}/api/config`))).text();
  assert(
    !publicConfig.includes("privileged-placeholder") &&
      !publicConfig.includes("server-placeholder"),
  );
  assert(
    (await handler(new Request(`${config.origin}/api/messages`))).status ===
      401,
  );
  assert(
    (await handler(
      request("/api/chat", { content: "Hi" }, "https://attacker.example"),
    )).status === 403,
  );
  await mock(() => Promise.resolve(response({}, 401)), async () => {
    assert((await handler(request("/api/messages"))).status === 401);
  });
});
Deno.test("authenticated queries and inserts use verified owner and user token, not service key", async () => {
  await mock((input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    assert(
      headers.get("Authorization") === ["Bearer", "test-session"].join(" "),
    );
    if (url.includes("/auth/v1/user")) {
      return Promise.resolve(response({ id: owner }));
    }
    assert(url.includes(`user_id=eq.${owner}`));
    return Promise.resolve(response([]));
  }, async () => {
    assert(
      (await createHandler(config)(request("/api/messages"))).status === 200,
    );
  });
  await mock((_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert(body.user_id === owner);
    return Promise.resolve(response([body]));
  }, async () => {
    await new Database(config, "test-session", owner).insert("messages", {
      user_id: "other",
      role: "user",
      content: "Hi",
    });
  });
});
Deno.test("consent, confirmation IDs and request bodies are validated before writes", async () => {
  await mock((input) => {
    assert(
      String(input).includes("/auth/v1/user"),
      "Unexpected database write",
    );
    return Promise.resolve(response({ id: owner }));
  }, async () => {
    const handler = createHandler(config);
    assert(
      (await handler(request("/api/chat", { content: "Hi" }))).status === 400,
    );
    assert(
      (await handler(
        request("/api/chat", { content: " ".repeat(10), ai_consent: true }),
      )).status === 400,
    );
    assert(
      (await handler(
        request("/api/confirm", { message_id: "bad", cancel: false }),
      )).status === 400,
    );
    assert(
      (await handler(request("/api/chat", { content: "a".repeat(20000) })))
        .status === 400,
    );
  });
});
Deno.test("AI action is validated and saved pending without mutating assets", async () => {
  let assistantSaved = false;
  await mock((input, init) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) {
      return Promise.resolve(response({ id: owner }));
    }
    if (url.includes("openrouter.ai")) {
      return Promise.resolve(
        response({
          choices: [{
            message: {
              content: JSON.stringify({
                reply: "Add this bike? Confirm below.",
                proposal: {
                  op: "add_asset",
                  data: {
                    description: "Bike",
                    value_minor: 60000,
                    user_id: "other",
                  },
                },
              }),
            },
          }],
        }),
      );
    }
    if (init?.method === "POST") {
      assert(
        url.endsWith("/messages"),
        "Unconfirmed action wrote to a data table",
      );
      const body = JSON.parse(String(init.body));
      if (body.role === "assistant") {
        assistantSaved = true;
        assert(
          body.action_state === "pending" &&
            body.proposal.data.user_id === undefined,
        );
      }
      return Promise.resolve(response([{ ...body, id: owner }]));
    }
    if (url.includes("/profiles?")) {
      return Promise.resolve(
        response([{
          id: owner,
          timezone: "UTC",
          currency: "USD",
          budget_minor: null,
        }]),
      );
    }
    return Promise.resolve(response([]));
  }, async () => {
    const result = await createHandler(config)(
      request("/api/chat", { content: "Add a bike", ai_consent: true }),
    );
    assert(result.status === 200 && assistantSaved);
  });
});
Deno.test("scheduler scopes delivery by persisted reminder ID and occurrence; no privileged key in chat", async () => {
  const calls: unknown[] = [];
  await mock((input, init) => {
    const url = String(input);
    if (url.includes("/reminders?")) {
      return Promise.resolve(response([{
        id: owner,
        user_id: owner,
        description: "Plan",
        cron: "0 9 * * *",
        timezone: "UTC",
        next_run: "2020-01-01T09:00:00Z",
      }]));
    }
    assert(url.endsWith("/rpc/deliver_reminder"));
    calls.push(JSON.parse(String(init?.body)));
    return Promise.resolve(response(true));
  }, async () => {
    const job = startScheduler({
      ...config,
      serviceKey: "privileged-placeholder",
    });
    assert(job);
    // Startup trigger finishes before the next explicit trigger.
    await new Promise((resolve) => setTimeout(resolve, 20));
    job.stop();
    assert(calls.length === 1);
    const call = calls[0] as Record<string, unknown>;
    assert(
      call.p_id === owner && call.p_expected_run === "2020-01-01T09:00:00Z",
    );
    assert(Date.parse(String(call.p_next_run)) > Date.now());
  });
  assert(startScheduler(config) === null);
});
