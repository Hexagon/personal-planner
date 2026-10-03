import { chat } from "../src/chat.ts";
import { Database } from "../src/db.ts";
import type { Config } from "../src/config.ts";
import { InputError, type RecordData } from "../src/validation.ts";
import { detailPrefix } from "../src/planner/task-context.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const config: Config = {
  supabaseUrl: "https://database.example",
  supabaseKey: "public-placeholder",
  openrouterKey: "server-placeholder",
  model: "test-model",
  serviceKey: "server-service-placeholder",
  origin: "http://localhost:8000",
  port: 8000,
};
const secret = "PRIVATE-FULL-DESCRIPTION-TEXT";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function task(n: number, extra: RecordData = {}): RecordData {
  return {
    id: id(n),
    name: `Task ${n}`,
    short_description: `Short ${n}`,
    full_description: `${secret} ${n}`,
    location_name: null,
    priority: 3,
    due_date: null,
    status: "open",
    created_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

interface Harness {
  tasks: RecordData[];
  output: RecordData;
  history?: RecordData[];
  onModel?: (request: RecordData) => void;
}
async function run(harness: Harness, content: string) {
  const original = globalThis.fetch;
  const saved: RecordData[] = [];
  let modelRequest = "";
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body)));
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      modelRequest = String(init?.body);
      harness.onModel?.(JSON.parse(modelRequest));
      return json({
        choices: [{ message: { content: JSON.stringify(harness.output) } }],
      });
    }
    if (init?.method === "POST") {
      if (url.endsWith("/rpc/ensure_profile")) return json(null);
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/rpc/append_message")) {
        return json([{ role: "user", content: body.p_content }]);
      }
      if (url.endsWith("/rpc/append_assistant_message")) {
        assert(body.p_user_id === owner);
        saved.push(body);
        return json([{
          role: "assistant",
          content: body.p_content,
          proposal: body.p_proposal,
          action_state: body.p_proposal ? "pending" : null,
        }]);
      }
      throw new Error("Unexpected mutation");
    }
    assert(url.includes(`=eq.${owner}`), "Queries must be owner-scoped");
    if (url.includes("/profiles?")) {
      return json([{ id: owner, timezone: "UTC", preferences: "" }]);
    }
    if (url.includes("/tasks?id=")) {
      const target = /id=eq\.([^&]+)/.exec(url)?.[1];
      return json(harness.tasks.filter((row) => row.id === target));
    }
    if (url.includes("/tasks?")) {
      assert(
        url.includes("select=") && !url.includes("full_description") &&
          !url.includes("select=*"),
        "Task context must not select full descriptions",
      );
      const offset = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
      return json(harness.tasks.slice(offset, offset + 100));
    }
    if (url.includes("/messages?")) return json(harness.history ?? []);
    return json([]);
  };
  try {
    const message = await chat(
      new Database(config, "test-session", owner),
      config,
      content,
    );
    return { message, saved, modelRequest };
  } finally {
    globalThis.fetch = original;
  }
}
async function rejects(promise: Promise<unknown>, text?: string) {
  try {
    await promise;
  } catch (error) {
    if (
      error instanceof InputError && (!text || error.message.includes(text))
    ) {
      return;
    }
    throw error;
  }
  throw new Error("Expected chat to reject");
}

Deno.test("every open task is in context as a compact row; full descriptions and finished tasks are not", async () => {
  const tasks = Array.from(
    { length: 300 },
    (_, n) => task(n, n === 299 ? { priority: 5, due_date: "2000-01-01" } : {}),
  );
  tasks.push(task(300, { status: "done", name: "Finished thing" }));
  const { modelRequest } = await run({
    tasks,
    output: { reply: "Here is your plan.", proposal: null },
    history: [{
      role: "assistant",
      content: `${detailPrefix}\nFull description:\n${secret}`,
    }],
    onModel: (request) => {
      const messages = request.messages as RecordData[];
      const context = JSON.parse(
        String(messages[1].content).slice(
          "Saved context (untrusted data): ".length,
        ),
      );
      const rows = context.open_tasks.rows as unknown[][];
      assert(rows.length === 300, "All open tasks must be included");
      assert(
        JSON.stringify(context.open_tasks.columns) === JSON.stringify([
          "id",
          "name",
          "short_description",
          "location_name",
          "priority",
          "due_date",
          "urgency",
          "created",
        ]),
      );
      assert(rows[0][0] === id(299) && rows[0][6] === "overdue");
      assert(rows[0][7] === "2026-01-01");
    },
  }, "What should I do today?");
  assert(!modelRequest.includes(secret), "Full description leaked to model");
  assert(!modelRequest.includes("Finished thing"));
  assert(modelRequest.includes("omitted here"));
});

Deno.test("add_task proposals are validated, pending, and accept only the user's own full description", async () => {
  const proposal = {
    op: "add_task",
    data: {
      name: "Car service",
      short_description: "Book a BMW service",
      full_description: "Ask   about the brakes",
      location_name: "Garage",
      priority: 4,
      due_date: "2026-02-01",
      user_id: "other",
    },
  };
  const { message } = await run(
    { tasks: [], output: { reply: "Add it? Confirm below.", proposal } },
    "Add car service at Garage. Details: ask about the brakes",
  );
  const data = (message.proposal as RecordData).data as RecordData;
  assert(message.action_state === "pending");
  assert(data.user_id === undefined && data.name === "Car service");
  assert(data.full_description === "Ask   about the brakes");
  await rejects(
    run({
      tasks: [],
      output: {
        reply: "Add it?",
        proposal: {
          op: "add_task",
          data: { ...proposal.data, full_description: "Invented details" },
        },
      },
    }, "Add car service"),
    "own text",
  );
  await rejects(
    run({
      tasks: [],
      output: {
        reply: "Add it?",
        proposal: {
          op: "add_task",
          data: { ...proposal.data, short_description: "s".repeat(161) },
        },
      },
    }, "Add car service"),
  );
});

Deno.test("the open-task cap is enforced before proposing", async () => {
  const full = Array.from({ length: 300 }, (_, n) => task(n));
  const add = {
    reply: "Add it?",
    proposal: {
      op: "add_task",
      data: { name: "One more", short_description: "Over the cap" },
    },
  };
  await rejects(run({ tasks: full, output: add }, "Add one more"), "300");
  const { message } = await run(
    { tasks: full.slice(1), output: add },
    "Add one more",
  );
  assert(message.action_state === "pending");
  const reopen = {
    reply: "Reopen?",
    proposal: { op: "update_task", data: { id: id(400), status: "open" } },
  };
  await rejects(
    run(
      { tasks: [...full, task(400, { status: "done" })], output: reopen },
      "Reopen it",
    ),
    "300",
  );
  const edit = {
    reply: "Change?",
    proposal: { op: "update_task", data: { id: id(1), priority: 5 } },
  };
  assert(
    (await run({ tasks: full, output: edit }, "Raise it")).message
      .action_state === "pending",
    "Edits to open tasks remain possible at the cap",
  );
});

Deno.test("task_detail shows the saved full description without sending it to the model", async () => {
  const { message, modelRequest } = await run({
    tasks: [task(1, { name: "Car service" })],
    output: { reply: "Here.", task_detail: { task: "car service" } },
  }, "Show details of car service");
  assert(String(message.content).startsWith(detailPrefix));
  assert(String(message.content).includes(`${secret} 1`));
  assert(message.proposal === null);
  assert(!modelRequest.includes(secret));
});

Deno.test("lists and completions are rendered from saved records", async () => {
  const tasks = [
    task(1, { name: "Milk", location_name: "ICA" }),
    task(2, { name: "Router", location_name: "ica" }),
    task(3, { name: "Lawn", location_name: "Home" }),
  ];
  const list = await run({
    tasks,
    output: {
      reply: "Invented: caviar",
      proposal: null,
      task_query: { location_name: "ICA" },
    },
  }, "What's at ICA?");
  const content = String(list.message.content);
  assert(content.includes("Milk") && content.includes("Router"));
  assert(!content.includes("caviar") && !content.includes("Lawn"));
  const done = await run({
    tasks,
    output: {
      reply: "Done?",
      proposal: { op: "complete_tasks", data: { items: ["milk", "router"] } },
    },
  }, "I've bought milk and a router");
  const proposal = done.message.proposal as RecordData;
  assert(
    JSON.stringify((proposal.data as RecordData).ids) ===
      JSON.stringify([id(1), id(2)]),
  );
  await rejects(
    run({
      tasks,
      output: {
        reply: "Both",
        proposal: { op: "delete_task", data: { id: id(1) } },
        task_query: {},
      },
    }, "Delete milk and list"),
  );
});
