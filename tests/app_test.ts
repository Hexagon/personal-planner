import { encode } from "@auth/core/jwt";
import { authConfig } from "../src/auth.ts";
import { createHandler } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { Database, dueReminders } from "../src/db.ts";
import { runSchedulerTick } from "../src/scheduler.ts";
import {
  InputError,
  maxOpenTasks,
  type RecordData,
} from "../src/validation.ts";

const owner = "google:11111111";
const otherOwner = "github:22222222";
const config: Config = {
  openrouterKey: "server-placeholder",
  model: "deepseek/deepseek-v4-flash",
  authSecret: "test-auth-secret-for-planner-tests-at-least-32-bytes",
  googleClientId: "google-client",
  googleClientSecret: "google-secret",
  githubClientId: "github-client",
  githubClientSecret: "github-secret",
  origin: "http://localhost:8000",
  port: 8000,
};
const sessionCookie = async (userId = owner) => {
  const name = "authjs.session-token";
  const token = await encode({
    secret: config.authSecret,
    salt: name,
    token: { sub: userId },
  });
  return `${name}=${token}`;
};
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function request(
  path: string,
  body?: unknown,
  origin = config.origin,
  cookie?: string,
) {
  return new Request(`${config.origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      Origin: origin,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function withKv(test: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await test(kv);
  } finally {
    await kv.close();
  }
}
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function task(n: number, status = "open"): RecordData {
  const timestamp = "2026-10-01T00:00:00.000Z";
  return {
    id: id(n),
    user_id: owner,
    name: `Task ${n}`,
    short_description: `Short ${n}`,
    full_description: null,
    location_name: null,
    priority: 3,
    due_date: null,
    status,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: null,
  };
}

Deno.test("public config is safe; APIs require same-origin requests and a valid Auth.js session", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(config, kv);
    const publicConfig =
      await (await handler(new Request(`${config.origin}/api/config`))).text();
    assert(!publicConfig.includes("google-secret"));
    assert(!publicConfig.includes("github-secret"));
    assert(!publicConfig.includes("server-placeholder"));
    assert(publicConfig.includes("deepseek/deepseek-v4-pro"));
    assert(publicConfig.includes('"id":"google"'));
    assert(publicConfig.includes('"id":"github"'));
    assert(
      (await handler(request("/api/messages"))).status === 401,
      "An absent session must be rejected",
    );
    assert(
      (await handler(
        request("/api/chat", { content: "Hi" }, "https://attacker.example"),
      )).status === 403,
      "Cross-origin writes must be rejected",
    );
    const cookie = await sessionCookie();
    const messages = await handler(
      request("/api/messages", undefined, undefined, cookie),
    );
    assert(messages.status === 200);
    assert(Array.isArray(await messages.json()));
    const expiredName = "authjs.session-token";
    const expiredToken = await encode({
      secret: config.authSecret,
      salt: expiredName,
      maxAge: -1,
      token: { sub: owner },
    });
    assert(
      (await handler(
        request(
          "/api/messages",
          undefined,
          config.origin,
          `${expiredName}=${expiredToken}`,
        ),
      )).status === 401,
      "Expired Auth.js sessions must be rejected",
    );
  });
});

Deno.test("Auth.js enables only configured OAuth providers and serves CSRF tokens", async () => {
  const googleOnly = authConfig({
    ...config,
    githubClientId: undefined,
    githubClientSecret: undefined,
  });
  assert(
    googleOnly.providers.length === 1,
  );
  await withKv(async (kv) => {
    const csrf = await createHandler(config, kv)(
      new Request(`${config.origin}/auth/csrf`),
    );
    assert(csrf.ok);
    const payload = await csrf.json();
    assert(
      typeof payload.csrfToken === "string" && payload.csrfToken.length > 20,
    );
    assert(csrf.headers.has("set-cookie"));
  });
});

Deno.test("KV records and ownership are isolated by the Auth.js identity", async () => {
  await withKv(async (kv) => {
    const db = new Database(kv, owner);
    await db.ensureProfile();
    await db.insert("messages", {
      role: "user",
      content: "Hello",
      user_id: otherOwner,
    });
    assert((await db.list("messages")).length === 1);
    assert((await new Database(kv, otherOwner).list("messages")).length === 0);
    assert((await db.list("messages"))[0].user_id === owner);
    await kv.set(["planner", "tasks", owner, id(1)], task(1));
    let rejected = false;
    try {
      await db.owned("tasks", "invalid");
    } catch (error) {
      rejected = error instanceof InputError;
    }
    assert(rejected, "IDs must be valid UUIDs");
    assert((await db.owned("tasks", id(1).toUpperCase())).id === id(1));
    assert((await kv.get(["planner", "messages", otherOwner])).value === null);
  });
});

Deno.test("consent, confirmation IDs and request bodies are validated before AI or writes", async () => {
  await withKv(async (kv) => {
    const cookie = await sessionCookie();
    const handler = createHandler(config, kv);
    assert(
      (await handler(
        request("/api/chat", { content: "Hi" }, config.origin, cookie),
      ))
        .status === 400,
    );
    assert(
      (await handler(
        request(
          "/api/chat",
          { content: " ".repeat(10), ai_consent: true },
          config.origin,
          cookie,
        ),
      )).status === 400,
    );
    assert(
      (await handler(
        request(
          "/api/chat",
          {
            content: "Hi",
            ai_consent: true,
            model: "untrusted/provider-model",
          },
          config.origin,
          cookie,
        ),
      )).status === 400,
    );
    assert(
      (await handler(
        request(
          "/api/chat",
          { content: "Hi", ai_consent: true, online_search: "yes" },
          config.origin,
          cookie,
        ),
      )).status === 400,
    );
    assert(
      (await handler(
        request(
          "/api/confirm",
          { message_id: "bad", cancel: false },
          config.origin,
          cookie,
        ),
      )).status === 400,
    );
    assert(
      (await handler(
        request(
          "/api/chat",
          { content: "a".repeat(20000), ai_consent: true },
          config.origin,
          cookie,
        ),
      )).status === 400,
    );
  });
});

Deno.test("confirmation applies a task mutation once and uses a transactional task cap", async () => {
  await withKv(async (kv) => {
    const db = new Database(kv, owner);
    await db.ensureProfile();
    const [message] = await db.insert("messages", {
      role: "assistant",
      content: "Add task? Confirm below.",
      proposal: {
        op: "add_task",
        data: { name: "Bike service", short_description: "Service bikes" },
      },
    });
    assert(await db.confirm(message.id, false));
    assert(!(await db.confirm(message.id, false)));
    const rows = await db.list("tasks");
    assert(rows.length === 1 && rows[0].name === "Bike service");
    assert(
      (await kv.get<RecordData>([
        "planner",
        "messages",
        owner,
        String(message.id),
      ])).value?.action_state === "confirmed",
    );

    for (let index = 0; index < maxOpenTasks - 2; index++) {
      await kv.set(
        ["planner", "tasks", owner, id(index + 10)],
        task(index + 10),
      );
    }
    const proposals = await Promise.all([
      db.insert("messages", {
        role: "assistant",
        content: "Add one? Confirm.",
        proposal: {
          op: "add_task",
          data: { name: "One", short_description: "One more" },
        },
      }),
      db.insert("messages", {
        role: "assistant",
        content: "Add another? Confirm.",
        proposal: {
          op: "add_task",
          data: { name: "Two", short_description: "Another one" },
        },
      }),
    ]);
    const results = await Promise.allSettled(
      proposals.map(([proposal]) => db.confirm(proposal.id, false)),
    );
    assert(
      results.filter((result) => result.status === "fulfilled").length === 1,
    );
    assert(
      results.filter((result) => result.status === "rejected").length === 1,
    );
    assert(
      (await db.list("tasks")).filter((row) => row.status === "open").length ===
        300,
    );
  });
});

Deno.test("profile, batch-task, and reminder changes are confirmed and atomic", async () => {
  await withKv(async (kv) => {
    const db = new Database(kv, owner);
    await db.ensureProfile();
    const profile = await db.insert("messages", {
      role: "assistant",
      content: "Set timezone?",
      proposal: { op: "set_profile", data: { timezone: "Europe/Stockholm" } },
    });
    assert(await db.confirm(profile[0].id, false));
    assert((await db.list("profiles"))[0].timezone === "Europe/Stockholm");

    const taskIds = Array.from({ length: 20 }, (_, index) => id(index + 100));
    for (let index = 0; index < taskIds.length; index++) {
      await kv.set(
        ["planner", "tasks", owner, taskIds[index]],
        task(index + 100),
      );
    }
    const completion = await db.insert("messages", {
      role: "assistant",
      content: "Complete these?",
      proposal: { op: "complete_tasks", data: { ids: taskIds } },
    });
    assert(await db.confirm(completion[0].id, false));
    assert(
      (await db.list("tasks")).every((row) => row.status === "done"),
      "A batch completion must update every task",
    );
    const reopen = await db.insert("messages", {
      role: "assistant",
      content: "Reopen task?",
      proposal: {
        op: "update_task",
        data: { id: taskIds[0], status: "open" },
      },
    });
    assert(await db.confirm(reopen[0].id, false));
    const reopened = await db.owned("tasks", taskIds[0]);
    assert(reopened.status === "open" && reopened.completed_at === null);
    const deleteTask = await db.insert("messages", {
      role: "assistant",
      content: "Delete task?",
      proposal: { op: "delete_task", data: { id: taskIds[0] } },
    });
    assert(await db.confirm(deleteTask[0].id, false));
    assert((await db.list("tasks")).length === 19);

    const reminder = await db.insert("messages", {
      role: "assistant",
      content: "Add reminder?",
      proposal: {
        op: "add_reminder",
        data: {
          description: "Plan",
          cron: "0 9 * * *",
          timezone: "UTC",
          next_run: new Date().toISOString(),
        },
      },
    });
    assert(await db.confirm(reminder[0].id, false));
    const [savedReminder] = await db.list("reminders");
    assert(
      savedReminder.description === "Plan" && savedReminder.active === true,
    );
    assert((await dueReminders(kv, "2999-01-01T00:00:00.000Z")).length === 1);

    const deleteReminder = await db.insert("messages", {
      role: "assistant",
      content: "Delete reminder?",
      proposal: {
        op: "delete_reminder",
        data: { id: savedReminder.id },
      },
    });
    assert(await db.confirm(deleteReminder[0].id, false));
    assert((await db.list("reminders")).length === 0);
    assert((await dueReminders(kv, "2999-01-01T00:00:00.000Z")).length === 0);
  });
});

Deno.test("cancellation reports a lost pending-state race", async () => {
  await withKv(async (kv) => {
    const db = new Database(kv, owner);
    const [message] = await db.insert("messages", {
      role: "assistant",
      content: "Add task?",
      proposal: {
        op: "add_task",
        data: { name: "Bike", short_description: "Service bike" },
      },
    });
    assert(await db.confirm(message.id, true));
    assert(!(await db.confirm(message.id, true)));
    assert((await db.list("tasks")).length === 0);
  });
});

Deno.test("the AI action is saved pending without mutating tasks", async () => {
  await withKv(async (kv) => {
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      assert(String(input).includes("openrouter.ai"));
      const body = JSON.parse(String(init?.body));
      assert(body.model === "deepseek/deepseek-v4-pro");
      return Promise.resolve(
        new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                reply: "Add this task? Confirm below.",
                proposal: {
                  op: "add_task",
                  data: {
                    name: "Bike service",
                    short_description: "Service the family bikes",
                    user_id: otherOwner,
                  },
                },
              }),
            },
          }],
        })),
      );
    };
    try {
      const cookie = await sessionCookie();
      const result = await createHandler(config, kv)(
        request(
          "/api/chat",
          {
            content: "Service the bikes",
            ai_consent: true,
            model: "deepseek/deepseek-v4-pro",
          },
          config.origin,
          cookie,
        ),
      );
      assert(result.status === 200);
      const message = await result.json();
      assert(message.action_state === "pending");
      assert((await new Database(kv, owner).list("tasks")).length === 0);
      assert((message.proposal.data as RecordData).user_id === undefined);
    } finally {
      globalThis.fetch = original;
    }
  });
});

Deno.test("reminder delivery is owner-derived, bounded, and atomically advances its occurrence", async () => {
  await withKv(async (kv) => {
    const reminderId = id(500);
    const due = "2020-01-01T09:00:00.000Z";
    const row: RecordData = {
      id: reminderId,
      user_id: otherOwner,
      description: "Plan the week",
      cron: "0 9 * * *",
      timezone: "UTC",
      next_run: due,
      active: true,
      created_at: due,
    };
    await kv.set(["planner", "reminders", otherOwner, reminderId], row);
    await kv.set(["planner", "due", due, otherOwner, reminderId], reminderId);
    assert((await dueReminders(kv, new Date().toISOString(), 50)).length === 1);
    await runSchedulerTick(kv);
    const messages = await new Database(kv, otherOwner).list("messages");
    assert(messages.length === 1);
    assert(messages[0].content === "Reminder: Plan the week");
    const updated = await kv.get<RecordData>([
      "planner",
      "reminders",
      otherOwner,
      reminderId,
    ]);
    assert(Date.parse(String(updated.value?.next_run)) > Date.now());
    assert((await dueReminders(kv, new Date().toISOString(), 50)).length === 0);
    await runSchedulerTick(kv);
    assert((await new Database(kv, otherOwner).list("messages")).length === 1);
  });
});

Deno.test("invalid reminder schedules are quarantined without blocking due reminders", async () => {
  await withKv(async (kv) => {
    const invalidId = id(600);
    const validId = id(601);
    const due = "2020-01-01T09:00:00.000Z";
    for (
      const [reminderId, cron] of [[invalidId, "invalid"], [
        validId,
        "0 9 * * *",
      ]]
    ) {
      const row: RecordData = {
        id: reminderId,
        user_id: owner,
        description: reminderId,
        cron,
        timezone: "UTC",
        next_run: due,
        active: true,
        created_at: due,
      };
      await kv.set(["planner", "reminders", owner, reminderId], row);
      await kv.set(["planner", "due", due, owner, reminderId], reminderId);
    }
    await runSchedulerTick(kv);
    const invalid = await kv.get<RecordData>([
      "planner",
      "reminders",
      owner,
      invalidId,
    ]);
    const valid = await kv.get<RecordData>([
      "planner",
      "reminders",
      owner,
      validId,
    ]);
    assert(invalid.value?.active === false);
    assert(Date.parse(String(valid.value?.next_run)) > Date.now());
    assert((await new Database(kv, owner).list("messages")).length === 1);
  });
});
