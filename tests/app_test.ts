import { encode } from "@auth/core/jwt";
import { authConfig } from "../src/auth.ts";
import { createHandler, isPreviewDeployment } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { Database, deliverReminder, dueReminders } from "../src/db.ts";
import { runSchedulerTick } from "../src/scheduler.ts";
import { upcoming } from "../src/upcoming.ts";
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

Deno.test("timezone Settings are authenticated, owner scoped and saved without AI consent", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(config, kv);
    const cookie = await sessionCookie();
    assert((await handler(request("/api/settings"))).status === 401);
    assert(
      (await handler(request("/api/settings", { timezone: "UTC" }))).status ===
        401,
    );
    const get = () =>
      handler(request("/api/settings", undefined, config.origin, cookie));
    assert((await (await get()).json()).timezone === null);
    await new Database(kv, owner).ensureProfile();
    assert((await (await get()).json()).timezone === null);
    const save = () =>
      handler(
        request(
          "/api/settings",
          { timezone: "Europe/Stockholm" },
          config.origin,
          cookie,
        ),
      );
    assert((await save()).status === 200);
    assert((await save()).status === 200);
    assert((await (await get()).json()).timezone === "Europe/Stockholm");
    assert((await kv.get(["planner", "profiles", otherOwner])).value === null);
    const other = await handler(
      request(
        "/api/settings",
        undefined,
        config.origin,
        await sessionCookie(otherOwner),
      ),
    );
    assert((await other.json()).timezone === null);
    assert((await new Database(kv, owner).list("messages")).length === 0);
    const profile = (await new Database(kv, owner).list("profiles"))[0];
    assert(profile.id === owner && profile.timezone_configured === true);
  });
});

Deno.test("timezone Settings reject cross-origin requests, invalid zones and unknown fields", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(config, kv);
    const cookie = await sessionCookie();
    const body = { timezone: "Europe/Stockholm" };
    assert(
      (await handler(
        request("/api/settings", body, "https://other.example", cookie),
      )).status === 403,
    );
    for (
      const timezone of [
        null,
        12,
        "",
        "+02:00",
        "UTC+2",
        "Not/AZone",
        "<script>",
        "x".repeat(101),
      ]
    ) {
      assert(
        (await handler(
          request("/api/settings", { timezone }, config.origin, cookie),
        )).status === 400,
      );
    }
    for (
      const invalid of [{}, { ...body, user_id: otherOwner }, {
        ...body,
        preferences: "Injected",
      }]
    ) {
      assert(
        (await handler(
          request("/api/settings", invalid, config.origin, cookie),
        )).status === 400,
      );
    }
    assert(
      (await handler(
        request("/api/settings?owner=other", body, config.origin, cookie),
      )).status === 400,
    );
    assert(
      (await handler(
        request("/api/settings?owner=other", undefined, config.origin, cookie),
      )).status === 400,
    );
    assert((await kv.get(["planner", "profiles", owner])).value === null);
  });
});

Deno.test("timezone Settings preserve existing profiles and reminder schedules", async () => {
  await withKv(async (kv) => {
    const db = new Database(kv, owner);
    const key = ["planner", "profiles", owner];
    const profile = {
      id: owner,
      timezone: "UTC",
      preferences: "Brief replies",
      created_at: "2020-01-01T00:00:00.000Z",
    };
    await kv.set(key, profile);
    const handler = createHandler(config, kv);
    const cookie = await sessionCookie();
    assert(
      (await (await handler(
        request("/api/settings", undefined, config.origin, cookie),
      )).json()).timezone === "UTC",
    );
    const reminderKey = ["planner", "reminders", owner, id(200)];
    const reminder = {
      id: id(200),
      timezone: "UTC",
      cron: "0 18 * * 0",
      next_run: "2026-10-11T18:00:00.000Z",
    };
    await kv.set(reminderKey, reminder);
    await Promise.all([
      db.saveTimezone("Europe/Stockholm"),
      db.saveTimezone("America/New_York"),
    ]);
    const saved = (await kv.get<RecordData>(key)).value!;
    assert(
      saved.preferences === profile.preferences &&
        saved.created_at === profile.created_at,
    );
    assert(
      saved.timezone === "Europe/Stockholm" ||
        saved.timezone === "America/New_York",
    );
    assert(
      JSON.stringify((await kv.get(reminderKey)).value) ===
        JSON.stringify(reminder),
    );
  });
});

Deno.test("historical chat timezone proposals can no longer change profile timezone", async () => {
  await withKv(async (kv) => {
    const db = new Database(kv, owner);
    await db.saveTimezone("Europe/Stockholm");
    const message = (await db.insert("messages", {
      role: "assistant",
      content: "Old timezone proposal",
      proposal: { op: "set_profile", data: { timezone: "UTC" } },
    }))[0];
    let rejected = false;
    try {
      await db.confirm(message.id, false);
    } catch (error) {
      rejected = error instanceof InputError;
    }
    assert(rejected);
    assert((await db.list("profiles"))[0].timezone === "Europe/Stockholm");
  });
});

Deno.test("preview badge is limited to non-production Deno Deploy", () => {
  assert(!isPreviewDeployment(false, undefined));
  assert(!isPreviewDeployment(true, "production"));
  assert(isPreviewDeployment(true, "preview"));
  assert(isPreviewDeployment(true, undefined));
});

Deno.test("proposal cards are omitted from transcript history without crossing owners", async () => {
  await withKv(async (kv) => {
    const db = new Database(kv, owner);
    const other = new Database(kv, otherOwner);
    const old = (await db.insert("messages", {
      role: "assistant",
      content: "Add old task?",
      proposal: {
        op: "add_task",
        data: { name: "Old", short_description: "Old task" },
      },
    }))[0];
    // Ensure a strictly older index entry independent of clock resolution.
    const oldKey = ["planner", "messages", owner, String(old.id)];
    await kv.delete([
      "planner",
      "message_dates",
      owner,
      String(old.created_at),
      String(old.id),
    ]);
    await kv.set(oldKey, { ...old, created_at: "2000-01-01T00:00:00.000Z" });
    await kv.set([
      "planner",
      "message_dates",
      owner,
      "2000-01-01T00:00:00.000Z",
      String(old.id),
    ], old.id);
    for (let n = 0; n < 105; n++) {
      await db.insert("messages", { role: "user", content: `Recent ${n}` });
    }
    const foreign = (await other.insert("messages", {
      role: "assistant",
      content: "FOREIGN-CARD",
      proposal: { op: "set_profile", data: { preferences: "Other" } },
    }))[0];
    const handler = createHandler(config, kv);
    const cookie = await sessionCookie();
    const get = (path: string) =>
      handler(request(path, undefined, config.origin, cookie));
    const latest = await (await get("/api/messages?history=true")).json();
    const older = await (await get(
      `/api/messages?history=true&cursor=${encodeURIComponent(latest.cursor)}`,
    )).json();
    const historical = older.messages.find((message: RecordData) =>
      message.id === old.id
    );
    assert(historical);
    assert(historical.proposal === null && historical.action_state === null);
    assert(!String(historical.content).includes("Add old task?"));
    assert(
      (await get("/api/messages?pending=true")).status === 400,
    );
    const immediate = await (await get(`/api/messages?id=${old.id}`)).json();
    assert(immediate[0].proposal.data.name === "Old");
    const confirmed = await handler(
      request(
        "/api/confirm",
        { message_id: old.id, cancel: false },
        config.origin,
        cookie,
      ),
    );
    assert((await confirmed.json()).result === true);
    assert(await db.confirm(old.id, false) === false);
    assert(await db.confirm(foreign.id, false) === false);
    const status = await (await get(`/api/messages?id=${old.id}`)).json();
    assert(status[0].action_state === "confirmed");
    const unavailable = await (await get(`/api/messages?id=${foreign.id}`))
      .json();
    assert(unavailable.length === 0);
    assert((await get("/api/messages?pending=false")).status === 400);
  });
});

Deno.test("conversation history pages backward, stays owner scoped, and omits proposals", async () => {
  await withKv(async (kv) => {
    const other = new Database(kv, otherOwner);
    for (let n = 1; n <= 205; n++) {
      const created_at = new Date(Date.UTC(2026, 0, 1, 0, 0, n))
        .toISOString();
      const message: RecordData = {
        id: id(n),
        user_id: owner,
        role: n === 1 ? "assistant" : "user",
        content: `Message ${n}`,
        proposal: n === 1
          ? { op: "set_profile", data: { preferences: "Updated" } }
          : null,
        action_state: n === 1 ? "pending" : null,
        created_at,
      };
      await kv.set(["planner", "messages", owner, id(n)], message);
      await kv.set(
        ["planner", "message_dates", owner, created_at, id(n)],
        id(n),
      );
    }
    await other.insert("messages", {
      role: "user",
      content: "FOREIGN-MESSAGE",
    });
    const handler = createHandler(config, kv);
    const cookie = await sessionCookie();
    const get = (path: string) =>
      handler(request(path, undefined, config.origin, cookie));
    const latest = await (await get("/api/messages?history=true")).json();
    assert(
      latest.messages.length === 100 &&
        latest.messages[0].content === "Message 106" &&
        latest.messages[99].content === "Message 205" &&
        latest.cursor,
    );
    assert(!JSON.stringify(latest).includes("FOREIGN-MESSAGE"));
    const older = await (await get(
      `/api/messages?history=true&cursor=${encodeURIComponent(latest.cursor)}`,
    )).json();
    assert(
      older.messages.length === 100 &&
        older.messages[0].content === "Message 6" &&
        older.messages[99].content === "Message 105" &&
        older.cursor,
    );
    const confirm = await get("/api/confirm");
    assert(confirm.status === 405);
    const confirmed = await handler(
      request(
        "/api/confirm",
        { message_id: id(1), cancel: false },
        config.origin,
        cookie,
      ),
    );
    assert((await confirmed.json()).result === true);
    const oldest = await (await get(
      `/api/messages?history=true&cursor=${encodeURIComponent(older.cursor)}`,
    )).json();
    assert(
      oldest.messages.length === 5 &&
        oldest.messages[0].content.includes(
          "previous proposal is no longer available",
        ) &&
        oldest.messages[0].action_state === null &&
        oldest.messages[0].proposal === null &&
        oldest.cursor === null,
    );
    assert(
      (await get("/api/messages?history=true&pending=true")).status === 400,
    );
  });
});

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

Deno.test("upcoming is authenticated, read-only, owner scoped and excludes private or inactive records", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(config, kv);
    assert((await handler(request("/api/upcoming"))).status === 401);
    const cookie = await sessionCookie();
    assert(
      (await handler(request("/api/upcoming", {}, config.origin, cookie)))
        .status === 405,
    );
    assert(
      (await handler(
        request("/api/upcoming?owner=other", undefined, config.origin, cookie),
      )).status === 400,
    );
    const empty = await (await handler(
      request("/api/upcoming", undefined, config.origin, cookie),
    )).json();
    assert(empty.timezone === "UTC" && empty.items.length === 0);
    for (
      const [n, status, due] of [
        [1, "open", "2026-10-04"],
        [2, "done", "2026-10-04"],
        [3, "cancelled", "2026-10-04"],
        [4, "open", null],
        [5, "open", "2026-10-04"],
      ] as const
    ) {
      const row: RecordData = { ...task(n, status), due_date: due };
      delete row.full_description;
      await kv.set(["planner", "tasks", owner, id(n)], row);
    }
    await kv.set(
      ["planner", "task_descriptions", owner, id(1)],
      "PRIVATE-DESCRIPTION",
    );
    await kv.set(["planner", "tasks", otherOwner, id(6)], {
      ...task(6),
      name: "FOREIGN-TASK",
      due_date: "2026-10-04",
    });
    await kv.set(["planner", "task_completions", owner, id(10)], {
      ids: [id(5)],
      revision: 1,
      completed_at: "2026-10-04T00:00:00Z",
    });
    for (
      const [user, n, active, description] of [
        [owner, 7, true, "Saved reminder"],
        [owner, 8, false, "DISABLED-REMINDER"],
        [otherOwner, 9, true, "FOREIGN-REMINDER"],
      ] as const
    ) {
      await kv.set(["planner", "reminders", user, id(n)], {
        id: id(n),
        active,
        description,
        timezone: "UTC",
        next_run: "2026-10-05T12:00:00.000Z",
      });
    }
    const response = await handler(
      request("/api/upcoming", undefined, config.origin, cookie),
    );
    assert(
      response.status === 200 &&
        response.headers.get("Cache-Control") === "no-store",
    );
    const body = await response.text();
    assert(
      !body.includes("PRIVATE-DESCRIPTION") &&
        !body.includes("full_description"),
    );
    assert(!body.includes("FOREIGN") && !body.includes("DISABLED"));
    assert(!body.includes("user_id") && !body.includes("task_revision"));
    const data = JSON.parse(body);
    assert(data.items.length === 2);
    assert(data.items[0].id === id(1) && data.items[1].id === id(7));
    const other = await (await handler(
      request(
        "/api/upcoming",
        undefined,
        config.origin,
        await sessionCookie(otherOwner),
      ),
    )).json();
    assert(
      other.items.length === 2 &&
        other.items.every((item: { title: string }) =>
          item.title.startsWith("FOREIGN")
        ),
    );
  });
});

Deno.test("upcoming respects local date boundaries, near-term windows, priority and pending delivery", async () => {
  await withKv(async (kv) => {
    const db = new Database(kv, owner);
    await kv.set(["planner", "profiles", owner], {
      timezone: "Europe/Stockholm",
    });
    for (
      const [n, due, priority] of [
        [1, "2026-10-03", 3],
        [2, "2026-10-04", 2],
        [3, "2026-10-04", 5],
        [4, "2026-10-05", 3],
        [5, "2027-01-01", 3],
      ] as const
    ) {
      const row: RecordData = { ...task(n), due_date: due, priority };
      delete row.full_description;
      await kv.set(["planner", "tasks", owner, id(n)], row);
    }
    const now = new Date("2026-10-03T22:30:00.000Z");
    for (
      const [n, when] of [
        [6, "2026-10-03T22:00:00.000Z"],
        [7, "2026-10-04T22:30:00.000Z"],
        [8, "2026-10-04T22:30:00.001Z"],
      ] as const
    ) {
      await kv.set(["planner", "reminders", owner, id(n)], {
        id: id(n),
        active: true,
        description: `Reminder ${n}`,
        timezone: "America/New_York",
        next_run: when,
      });
    }
    const data = await upcoming(db, now);
    const find = (n: number) => data.items.find((item) => item.id === id(n))!;
    assert(find(1).group === "Overdue" && find(1).attention);
    assert(find(2).group === "Today" && find(2).attention);
    assert(find(4).group === "Tomorrow" && !find(4).attention);
    assert(find(5).group === "Later" && !find(5).attention);
    assert(data.items.indexOf(find(3)) < data.items.indexOf(find(2)));
    assert(find(6).waiting && find(6).attention && find(6).group === "Today");
    assert(
      find(7).attention && !find(7).waiting && find(7).group === "Tomorrow",
    );
    assert(!find(8).attention);
    assert(find(7).timezone === "America/New_York");
    await kv.set(["planner", "profiles", owner], {
      timezone: "America/Los_Angeles",
    });
    const west = await upcoming(db, now);
    assert(west.items.find((item) => item.id === id(1))?.group === "Today");
    assert(west.items.find((item) => item.id === id(2))?.group === "Tomorrow");
  });
});

Deno.test("public config is safe; APIs require same-origin requests and a valid Auth.js session", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(config, kv);
    const publicConfig =
      await (await handler(new Request(`${config.origin}/api/config`))).text();
    assert(!publicConfig.includes("google-secret"));
    assert(!publicConfig.includes("github-secret"));
    assert(!publicConfig.includes("server-placeholder"));
    assert(publicConfig.includes("deepseek/deepseek-v4-pro"));
    assert(publicConfig.includes('"serverKeyAvailable":true'));
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
    assert(
      (await handler(
        new Request(`${config.origin}/auth/signout`, {
          method: "POST",
          headers: { Origin: "https://attacker.example" },
        }),
      )).status === 403,
      "Cross-origin Auth.js POSTs must be rejected",
    );
    const callback = await handler(
      new Request(`${config.origin}/auth/callback/google`, {
        method: "POST",
        headers: {
          Origin: "https://accounts.google.com",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(),
      }),
    );
    assert(
      callback.status !== 403,
      "OAuth callback POSTs must reach Auth.js for its state validation",
    );
    assert(
      (await handler(
        new Request(`${config.origin}/auth/callback/unknown`, {
          method: "POST",
          headers: { Origin: "https://attacker.example" },
        }),
      )).status === 403,
      "Unconfigured OAuth callback POSTs must remain same-origin only",
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

Deno.test("login form policy preserves same-origin sign-in without bypassing Origin or CSRF checks", async () => {
  await withKv(async (kv) => {
    const handler = createHandler(config, kv);
    const readTextFile = Deno.readTextFile;
    let page: Response;
    Deno.readTextFile = () => Promise.resolve("<!DOCTYPE html>");
    try {
      page = await handler(new Request(`${config.origin}/`));
    } finally {
      Deno.readTextFile = readTextFile;
    }
    assert(page.ok);
    assert(page.headers.get("Referrer-Policy") === "same-origin");
    assert(
      page.headers.get("Content-Security-Policy")?.includes(
        "form-action 'self' https://accounts.google.com https://github.com",
      ),
    );
    const csrf = await handler(new Request(`${config.origin}/auth/csrf`));
    const { csrfToken } = await csrf.json();
    const cookie = csrf.headers.getSetCookie().map((value) =>
      value.split(";")[0]
    ).join("; ");
    const signin = (
      origin: string | undefined,
      token = csrfToken,
      returnRedirect = false,
    ) =>
      handler(
        new Request(`${config.origin}/auth/signin/github`, {
          method: "POST",
          headers: {
            ...(origin === undefined ? {} : { Origin: origin }),
            Cookie: cookie,
            "Content-Type": "application/x-www-form-urlencoded",
            ...(returnRedirect ? { "X-Auth-Return-Redirect": "1" } : {}),
          },
          body: new URLSearchParams({ csrfToken: token, callbackUrl: "/" }),
        }),
      );
    for (const origin of [undefined, "null", "https://attacker.example"]) {
      const rejected = await signin(origin);
      assert(rejected.status === 403);
      assert((await rejected.json()).error === "Origin not allowed");
    }
    const invalidCsrf = await signin(config.origin, "invalid-csrf-token", true);
    assert(invalidCsrf.ok);
    const errorUrl = new URL((await invalidCsrf.json()).url);
    assert(errorUrl.origin === config.origin);
    assert(errorUrl.searchParams.get("error") === "MissingCSRF");
    const valid = await signin(config.origin);
    assert(valid.status === 302);
    assert(valid.headers.get("Referrer-Policy") === "same-origin");
    const authorizeUrl = new URL(valid.headers.get("Location")!);
    assert(authorizeUrl.origin === "https://github.com");
    assert(authorizeUrl.pathname === "/login/oauth/authorize");
    assert(
      authorizeUrl.searchParams.get("redirect_uri") ===
        `${config.origin}/auth/callback/github`,
    );
    assert(authorizeUrl.searchParams.has("code_challenge"));
    assert(authorizeUrl.searchParams.get("code_challenge_method") === "S256");
  });
});

Deno.test("BYOK is used only for chat and can replace a missing server key", async () => {
  await withKv(async (kv) => {
    const original = globalThis.fetch;
    const userKey = "test-user-key-for-byok-request-only";
    const noServerKey = { ...config, openrouterKey: undefined };
    globalThis.fetch = (input, init) => {
      assert(String(input).includes("openrouter.ai"));
      assert(
        new Headers(init?.headers).get("Authorization") ===
          "Bearer " + userKey,
      );
      assert(
        JSON.parse(String(init?.body)).reasoning.enabled === false,
        "Chat defaults to non-thinking mode",
      );
      return Promise.resolve(
        new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({ reply: "Hello", proposal: null }),
            },
          }],
        })),
      );
    };
    try {
      const handler = createHandler(noServerKey, kv);
      const publicConfig =
        await (await handler(new Request(`${config.origin}/api/config`)))
          .json();
      assert(publicConfig.serverKeyAvailable === false);
      const cookie = await sessionCookie();
      const missingKey = await handler(
        request(
          "/api/chat",
          { content: "Hi", ai_consent: true },
          config.origin,
          cookie,
        ),
      );
      assert(missingKey.status === 400);
      const invalidKey = await handler(
        request(
          "/api/chat",
          { content: "Hi", ai_consent: true, openrouter_key: 123 },
          config.origin,
          cookie,
        ),
      );
      assert(invalidKey.status === 400);
      const response = await handler(
        request(
          "/api/chat",
          { content: "Hi", ai_consent: true, openrouter_key: userKey },
          config.origin,
          cookie,
        ),
      );
      assert(response.status === 200);
      assert(!(await response.text()).includes(userKey));
      const overrideResponse = await createHandler(config, kv)(
        request(
          "/api/chat",
          { content: "Hello again", ai_consent: true, openrouter_key: userKey },
          config.origin,
          cookie,
        ),
      );
      assert(overrideResponse.status === 200);
      const messages = await new Database(kv, owner).list("messages");
      assert(messages.length === 4);
      assert(
        messages.every((message) => !String(message.content).includes(userKey)),
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

Deno.test("chat reasoning reaches the provider and failed AI calls release the request slot", async () => {
  await withKv(async (kv) => {
    const original = globalThis.fetch;
    const originalConsoleError = console.error;
    const handler = createHandler(config, kv);
    const cookie = await sessionCookie();
    const failures: string[] = [];
    let fail = true;
    let expected: unknown;
    console.error = (message?: unknown) => failures.push(String(message));
    globalThis.fetch = (_input, init) => {
      assert(
        JSON.stringify(JSON.parse(String(init?.body)).reasoning) ===
          JSON.stringify(expected),
      );
      return Promise.resolve(
        fail
          ? new Response("private-provider-response", { status: 503 })
          : new Response(JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({ reply: "Hello", proposal: null }),
              },
            }],
          })),
      );
    };
    try {
      for (const reasoning of ["high", "default"] as const) {
        expected = reasoning === "high"
          ? { effort: "high", exclude: true }
          : undefined;
        fail = true;
        const failed = await handler(
          request(
            "/api/chat",
            { content: "Hello", ai_consent: true, reasoning },
            config.origin,
            cookie,
          ),
        );
        assert(failed.status === 502);
        const failure = await failed.json();
        assert(
          failure.error.includes("OpenRouter is temporarily unavailable") &&
            failure.error.includes("HTTP 503"),
        );
        assert(
          /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(
            failure.request_id,
          ),
        );
        const log = JSON.parse(failures.at(-1) ?? "{}");
        assert(log.status === 502 && log.upstream_status === 503);
        fail = false;
        const success = await handler(
          request(
            "/api/chat",
            { content: "Hello again", ai_consent: true, reasoning },
            config.origin,
            cookie,
          ),
        );
        assert(success.status === 200);
        const result = await success.json();
        assert(result.timing.provider_ms >= 0);
        assert(result.timing.application_ms >= 0);
      }
      const saved = await new Database(kv, owner).list("messages");
      assert(saved.every((message) => message.timing === undefined));
      assert(
        saved.filter((message) => message.role === "assistant").length === 2,
      );
    } finally {
      globalThis.fetch = original;
      console.error = originalConsoleError;
    }
  });
});

Deno.test("malformed provider output uses correlated provider diagnostics", async () => {
  await withKv(async (kv) => {
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    const failures: string[] = [];
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                reply: "Add it?",
                proposal: { op: "add_task", data: { name: "Missing summary" } },
              }),
            },
          }],
        })),
      );
    console.error = (message?: unknown) => failures.push(String(message));
    try {
      const response = await createHandler(config, kv)(
        request(
          "/api/chat",
          { content: "Add a task", ai_consent: true },
          config.origin,
          await sessionCookie(),
        ),
      );
      assert(response.status === 502);
      const failure = await response.json();
      assert(
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(
          failure.request_id,
        ),
      );
      const log = JSON.parse(failures.at(-1) ?? "{}");
      assert(
        log.category === "provider_invalid_response" &&
          log.request_id === failure.request_id,
      );
      const saved = await new Database(kv, owner).list("messages");
      assert(saved.length === 1 && saved[0].role === "user");
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalConsoleError;
    }
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
    for (const reasoning of [null, false, {}, "low", "untrusted"]) {
      const response = await handler(
        request(
          "/api/chat",
          { content: "Hi", ai_consent: true, reasoning },
          config.origin,
          cookie,
        ),
      );
      assert(response.status === 400);
    }
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
        data: {
          name: "Bike service",
          short_description: "Service bikes",
          full_description: "Replace the worn chain",
          location_name: "Workshop",
          priority: 4,
          due_date: "2026-10-10",
        },
      },
    });
    assert(await db.confirm(message.id, false));
    assert(!(await db.confirm(message.id, false)));
    const rows = await db.list("tasks");
    assert(
      rows.length === 1 &&
        rows[0].name === "Bike service" &&
        rows[0].short_description === "Service bikes" &&
        rows[0].location_name === "Workshop" &&
        rows[0].priority === 4 &&
        rows[0].due_date === "2026-10-10" &&
        rows[0].status === "open" &&
        rows[0].user_id === owner,
      "Confirmation must save the proposed task fields",
    );
    assert(
      (await db.ownedTaskDetail(rows[0].id)).full_description ===
        "Replace the worn chain",
      "Confirmation must save the proposed private task details",
    );
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
        maxOpenTasks,
    );
  });
});

Deno.test("confirmation applies every requested task update field", async () => {
  await withKv(async (kv) => {
    const db = new Database(kv, owner);
    await db.ensureProfile();
    await kv.set(["planner", "tasks", owner, id(1)], task(1));
    const [message] = await db.insert("messages", {
      role: "assistant",
      content: "Update task?",
      proposal: {
        op: "update_task",
        data: {
          id: id(1),
          name: "Updated task",
          short_description: "Updated summary",
          full_description: "Updated private details",
          location_name: "ICA",
          priority: 5,
          due_date: "2026-10-10",
          status: "done",
        },
      },
    });

    assert(await db.confirm(message.id, false));
    const updated = await db.owned("tasks", id(1));
    assert(
      updated.name === "Updated task" &&
        updated.short_description === "Updated summary" &&
        updated.location_name === "ICA" &&
        updated.priority === 5 &&
        updated.due_date === "2026-10-10" &&
        updated.status === "done" &&
        typeof updated.completed_at === "string",
      "Confirmation must apply the proposed task fields and status",
    );
    assert(
      (await db.ownedTaskDetail(id(1))).full_description ===
        "Updated private details",
      "Confirmation must update the proposed private task details",
    );
  });
});

Deno.test("task updates retry when the task changes during confirmation", async () => {
  await withKv(async (kv) => {
    const taskKey = ["planner", "tasks", owner, id(1)] as const;
    const initial = task(1);
    delete initial.full_description;
    await kv.set(taskKey, initial);

    let injectDuringCommit = false;
    const wrapAtomic = (
      operation: ReturnType<Deno.Kv["atomic"]>,
    ): ReturnType<Deno.Kv["atomic"]> =>
      new Proxy(operation, {
        get(target, property) {
          if (property === "commit") {
            return async () => {
              if (injectDuringCommit) {
                injectDuringCommit = false;
                const current = await kv.get<RecordData>(taskKey);
                await kv.set(taskKey, {
                  ...current.value,
                  name: "Concurrent rename",
                });
              }
              return target.commit();
            };
          }
          const value = Reflect.get(target, property, target);
          if (["check", "set", "delete"].includes(String(property))) {
            return (...args: unknown[]) =>
              wrapAtomic(value.apply(target, args));
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const interceptedKv = new Proxy(kv, {
      get(target, property) {
        if (property === "atomic") {
          return () => wrapAtomic(target.atomic());
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Deno.Kv;
    const db = new Database(interceptedKv, owner);
    await db.ensureProfile();
    const [message] = await db.insert("messages", {
      role: "assistant",
      content: "Update task?",
      proposal: {
        op: "update_task",
        data: { id: id(1), priority: 5 },
      },
    });

    injectDuringCommit = true;
    assert(await db.confirm(message.id, false));
    const updated = await db.owned("tasks", id(1));
    assert(
      updated.name === "Concurrent rename" && updated.priority === 5,
      "A confirmed update must retry against the latest task version",
    );
  });
});

Deno.test("profile, batch-task, and reminder changes are confirmed and atomic", async () => {
  await withKv(async (kv) => {
    const db = new Database(kv, owner);
    await db.ensureProfile();
    const profile = await db.insert("messages", {
      role: "assistant",
      content: "Set preferences?",
      proposal: {
        op: "set_profile",
        data: {
          preferences: "Plan around school pickup",
        },
      },
    });
    await db.saveTimezone("Europe/Stockholm");
    assert(await db.confirm(profile[0].id, false));
    const savedProfile = (await db.list("profiles"))[0];
    assert(
      savedProfile.timezone === "Europe/Stockholm" &&
        savedProfile.preferences === "Plan around school pickup",
      "Preference confirmation must preserve the timezone saved from Settings",
    );

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
      (await db.owned("tasks", taskIds[0])).status === "done",
      "An owned-task read must honor compactable batch completion",
    );
    assert(
      (await db.list("tasks")).every((row) => row.status === "done"),
      "A batch completion must update every task",
    );
    let hasCompletionEvents = false;
    for await (
      const _ of kv.list({
        prefix: ["planner", "task_completions", owner],
      })
    ) hasCompletionEvents = true;
    assert(!hasCompletionEvents, "Task completion events must be compacted");
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
      savedReminder.description === "Plan" &&
        savedReminder.cron === "0 9 * * *" &&
        savedReminder.timezone === "UTC" &&
        typeof savedReminder.next_run === "string" &&
        savedReminder.active === true,
      "Confirmation must save the proposed reminder schedule",
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

Deno.test("reminders can be paused, resumed, and rescheduled through retry-safe confirmations", async () => {
  await withKv(async (kv) => {
    const db = new Database(kv, owner);
    const reminderId = id(700);
    const reminder = {
      id: reminderId,
      user_id: owner,
      description: "Plan the week",
      cron: "0 9 * * *",
      timezone: "UTC",
      next_run: "2026-01-01T09:00:00.000Z",
      active: true,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    await kv.set(["planner", "reminders", owner, reminderId], reminder);
    await kv.set(
      ["planner", "due", reminder.next_run, owner, reminderId],
      reminderId,
    );
    const pause = await db.insert("messages", {
      role: "assistant",
      content: "Pause?",
      proposal: {
        op: "update_reminder",
        data: { id: reminderId, active: false },
      },
    });
    assert(await db.confirm(pause[0].id, false));
    assert(!(await db.confirm(pause[0].id, false)));
    assert((await db.owned("reminders", reminderId)).active === false);
    assert((await dueReminders(kv, "2999-01-01T00:00:00.000Z")).length === 0);

    const resume = await db.insert("messages", {
      role: "assistant",
      content: "Resume?",
      proposal: {
        op: "update_reminder",
        data: { id: reminderId, active: true },
      },
    });
    assert(await db.confirm(resume[0].id, false));
    const resumed = await db.owned("reminders", reminderId);
    assert(
      resumed.active === true &&
        Date.parse(String(resumed.next_run)) > Date.now(),
    );
    assert((await dueReminders(kv, "2999-01-01T00:00:00.000Z")).length === 1);

    const descriptionEdit = await db.insert("messages", {
      role: "assistant",
      content: "Update description?",
      proposal: {
        op: "update_reminder",
        data: { id: reminderId, description: "Plan the week differently" },
      },
    });
    const pauseBeforeEdit = await db.insert("messages", {
      role: "assistant",
      content: "Pause?",
      proposal: {
        op: "update_reminder",
        data: { id: reminderId, active: false },
      },
    });
    assert(await db.confirm(pauseBeforeEdit[0].id, false));
    const newerSchedule = await db.insert("messages", {
      role: "assistant",
      content: "Change schedule?",
      proposal: {
        op: "update_reminder",
        data: { id: reminderId, cron: "0 10 * * 1" },
      },
    });
    assert(await db.confirm(newerSchedule[0].id, false));
    assert(await db.confirm(descriptionEdit[0].id, false));
    const latest = await db.owned("reminders", reminderId);
    assert(
      latest.description === "Plan the week differently" &&
        latest.active === false &&
        latest.cron === "0 10 * * 1" &&
        latest.timezone === "UTC",
      "A partial edit must preserve newer reminder state",
    );

    const reschedule = await db.insert("messages", {
      role: "assistant",
      content: "Change schedule?",
      proposal: {
        op: "update_reminder",
        data: {
          id: reminderId,
          description: "Plan the week",
          cron: "0 10 * * 1",
          timezone: "Europe/Stockholm",
          active: true,
        },
      },
    });
    assert(await db.confirm(reschedule[0].id, false));
    const updated = await db.owned("reminders", reminderId);
    assert(
      updated.cron === "0 10 * * 1" &&
        updated.timezone === "Europe/Stockholm" &&
        Date.parse(String(updated.next_run)) > Date.now(),
    );
    const due = await dueReminders(kv, "2999-01-01T00:00:00.000Z");
    assert(due.length === 1 && due[0].id === reminderId);

    const foreign = {
      ...reminder,
      id: id(701),
      user_id: otherOwner,
      active: true,
    };
    await kv.set(["planner", "reminders", otherOwner, foreign.id], foreign);
    const foreignUpdate = await db.insert("messages", {
      role: "assistant",
      content: "Foreign?",
      proposal: {
        op: "update_reminder",
        data: { id: foreign.id, active: false },
      },
    });
    let rejected = false;
    try {
      await db.confirm(foreignUpdate[0].id, false);
    } catch (error) {
      rejected = error instanceof InputError;
    }
    assert(rejected);
    assert(
      (await kv.get<RecordData>([
        "planner",
        "reminders",
        otherOwner,
        foreign.id,
      ])).value?.active,
    );
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
    const dueRemindersForTick = await dueReminders(
      kv,
      new Date().toISOString(),
      50,
    );
    assert(dueRemindersForTick.length === 1);
    assert(!(await deliverReminder(kv, dueRemindersForTick[0], due)));
    assert((await new Database(kv, otherOwner).list("messages")).length === 0);
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

Deno.test("task descriptions are stored separately and fetched only for details", async () => {
  await withKv(async (kv) => {
    const taskId = id(700);
    const taskKey = ["planner", "tasks", owner, taskId] as const;
    await kv.set(taskKey, {
      id: taskId,
      name: "Private task",
      short_description: "A compact summary",
      full_description: "Private details",
      status: "open",
      created_at: "2026-01-01T00:00:00Z",
    });
    const db = new Database(kv, owner);
    const [row] = await db.list("tasks", "id,name,short_description");
    assert(row.full_description === undefined);
    assert(
      (await kv.get<RecordData>(taskKey)).value?.full_description === undefined,
    );
    assert(
      (await kv.get(["planner", "task_descriptions", owner, taskId])).value ===
        "Private details",
    );
    assert(
      (await db.ownedTaskDetail(taskId)).full_description ===
        "Private details",
    );
  });
});

Deno.test("invalid reminder schedules are quarantined without blocking due reminders", async () => {
  await withKv(async (kv) => {
    const invalidId = id(600);
    const validId = id(601);
    const staleId = id(602);
    const due = "2020-01-01T09:00:00.000Z";
    await kv.set(["planner", "due", due, owner, staleId], staleId);
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
    assert(
      (await kv.get(["planner", "due", due, owner, staleId])).value === null,
    );
  });
});
