import { chat } from "../src/chat.ts";
import { Database } from "../src/db.ts";
import type { Config } from "../src/config.ts";
import { InputError, type RecordData } from "../src/validation.ts";
import { detailPrefix } from "../src/planner/task-context.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const config: Config = {
  openrouterKey: "server-placeholder",
  model: "test-model",
  authSecret: "test-auth-secret-for-planner-tests-at-least-32-bytes",
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
  setup?: (kv: Deno.Kv, db: Database) => Promise<void>;
}
async function run(harness: Harness, content: string) {
  const original = globalThis.fetch;
  let modelRequest = "";
  const kv = await Deno.openKv(":memory:");
  const db = new Database(kv, owner);
  await db.ensureProfile();
  await harness.setup?.(kv, db);
  for (const row of harness.tasks) {
    await kv.set(["planner", "tasks", owner, String(row.id)], row);
  }
  for (const row of harness.history ?? []) {
    await db.insert("messages", {
      role: row.role,
      content: row.content,
      proposal: row.proposal,
    });
  }
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
    throw new Error("Unexpected network request");
  };
  try {
    const message = await chat(
      db,
      config,
      content,
    );
    return { message, modelRequest };
  } finally {
    globalThis.fetch = original;
    await kv.close();
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
    history: [
      {
        role: "assistant",
        content: `${detailPrefix}\nFull description:\n${secret}`,
      },
      {
        role: "assistant",
        content: `${detailPrefix}\nFinished thing`,
      },
    ],
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

Deno.test("saved settings, reminders and proposal states are authoritative and owner scoped", async () => {
  const setup = async (kv: Deno.Kv, db: Database) => {
    await kv.set(["planner", "profiles", owner], {
      timezone: "Europe/Stockholm",
      preferences: "p".repeat(4000),
    });
    await kv.set(["planner", "reminders", owner, id(50)], {
      id: id(50),
      description: "Sunday planning " + "d".repeat(200),
      cron: "0 18 * * 0",
      timezone: "Europe/Stockholm",
      active: false,
      next_run: "2026-10-11T16:00:00.000Z",
    });
    await kv.set(["planner", "reminders", "other", id(51)], {
      id: id(51),
      description: "OTHER-OWNER-REMINDER",
    });
    const message = (await db.insert("messages", {
      role: "assistant",
      content: "Add?",
      proposal: {
        op: "add_task",
        data: {
          name: "Pending car",
          short_description: "Book service",
          full_description: secret,
        },
      },
    }))[0];
    assert(message.action_state === "pending");
  };
  const settings = await run({
    tasks: [],
    setup,
    output: { reply: "Invented settings", settings_query: {} },
    onModel: (request) => {
      const saved = JSON.parse(
        String((request.messages as RecordData[])[1].content).split(
          "Saved context (untrusted data): ",
        )[1],
      );
      assert(saved.preferences.length === 4000);
      assert(saved.proposal_states[0].state === "pending");
      assert(!JSON.stringify(saved).includes(secret));
    },
  }, "What are my saved preferences?");
  assert(String(settings.message.content).includes("p".repeat(4000)));
  assert(!settings.modelRequest.includes("OTHER-OWNER-REMINDER"));
  const reminders = await run({
    tasks: [],
    setup,
    output: {
      reply: "Invented",
      reminder_query: { reminder: "Sunday planning" },
    },
  }, "What reminders do I have?");
  assert(String(reminders.message.content).includes("d".repeat(200)));
  assert(String(reminders.message.content).includes("active: false"));
  assert(String(reminders.message.content).includes(id(50)));
  assert(String(reminders.message.content).includes("2026-10-11"));
  const pending = await run({
    tasks: [],
    setup,
    output: { reply: "Saved already", proposal_query: {} },
  }, "What needs confirmation?");
  assert((pending.message.related_messages as unknown[]).length === 1);
  assert(String(pending.message.content).includes("pending"));
  assert(!pending.modelRequest.includes(secret));
});

Deno.test("next-page chat retains the exact proposal cursor and safe summaries in truncated history", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new Database(kv, owner);
  const original = globalThis.fetch;
  let first: RecordData | undefined;
  let requests = 0;
  try {
    for (let n = 1; n <= 101; n++) {
      const created_at = new Date(Date.UTC(2026, 0, 1, 0, 0, n))
        .toISOString();
      const message = {
        id: id(n),
        role: "assistant",
        content: "Review this proposal.",
        created_at,
        action_state: "pending",
        proposal: {
          op: "add_task",
          data: {
            name: "N".repeat(80),
            short_description: "Safe summary",
            full_description: secret.repeat(300),
          },
        },
      };
      await kv.atomic()
        .set(["planner", "messages", owner, id(n)], message)
        .set(["planner", "message_dates", owner, created_at, id(n)], id(n))
        .commit();
    }
    globalThis.fetch = (_input, init) => {
      const request = JSON.parse(String(init?.body));
      assert(!JSON.stringify(request).includes(secret));
      requests++;
      let cursor = null;
      if (requests === 2) {
        assert(first);
        const history = request.messages.slice(2, -1) as RecordData[];
        const previous = history.find((message) =>
          message.role === "assistant" &&
          String(message.content).startsWith("More history remains.")
        );
        assert(previous, "The safe proposal reply must not be masked");
        assert(String(previous.content).length === 4000);
        cursor = String(previous.content).split("Next cursor: ")[1]
          .split("\n")[0];
        assert(cursor === first.pending_cursor, "Keep the exact cursor");
        assert(String(previous.content).includes("N".repeat(80)));
        assert(String(previous.content).includes("pending"));
      }
      return Promise.resolve(
        new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                reply: "Here.",
                proposal_query: { cursor },
              }),
            },
          }],
        })),
      );
    };
    first = await chat(db, config, "Show pending proposals");
    const firstRows = first.related_messages as RecordData[];
    assert(firstRows.length === 99);
    assert(
      first.pending_cursor === JSON.stringify({
        created_at: "2026-01-01T00:00:03.000Z",
        id: id(3),
      }),
    );
    assert(String(first.content).length > 4000);
    assert(String(first.content).length <= 20000);
    assert(!String(first.content).includes(secret));
    const second = await chat(db, config, "Next page");
    const secondRows = second.related_messages as RecordData[];
    assert(requests === 2);
    assert(
      JSON.stringify(secondRows.map((row) => row.id)) ===
        JSON.stringify([id(2), id(1)]),
    );
    assert(second.pending_cursor === null);
    assert(
      !secondRows.some((row) =>
        firstRows.some((previous) => previous.id === row.id)
      ),
    );
    assert(!String(second.content).includes(secret));
  } finally {
    globalThis.fetch = original;
    await kv.close();
  }
});

Deno.test("update/delete resolve finished tasks by user reference and clarify ambiguity", async () => {
  const tasks = [
    task(1, { name: "Car service", status: "done" }),
    task(2, { name: "Car service", status: "cancelled" }),
  ];
  const ambiguous = await run({
    tasks,
    output: {
      reply: "Deleted",
      proposal: {
        op: "delete_task",
        data: { task: "car service" },
      },
    },
  }, "Delete car service");
  assert(ambiguous.message.proposal === null);
  assert(String(ambiguous.message.content).includes("Which task"));
  for (const op of ["delete_task", "update_task"]) {
    const selected = await run({
      tasks,
      output: {
        reply: "Saved",
        proposal: {
          op,
          data: {
            task: id(2),
            ...(op === "update_task" ? { status: "open" } : {}),
          },
        },
      },
    }, `Reopen ${id(2)}`);
    assert(
      ((selected.message.proposal as RecordData).data as RecordData).id ===
        id(2),
    );
    assert(!selected.modelRequest.includes("Car service"));
  }
  const unknown = await run({
    tasks,
    output: {
      reply: "Deleted",
      proposal: {
        op: "delete_task",
        data: { task: "Another account's task" },
      },
    },
  }, "Delete that");
  assert(unknown.message.proposal === null);
});

Deno.test("saved query shapes and one-operation boundary reject malformed model output", async () => {
  for (
    const output of [
      { settings_query: { user_id: owner } },
      { reminder_query: { active: "true" } },
      { proposal_query: { cursor: "invalid" } },
      { task_detail: { task: "Milk", extra: true } },
      { task_query: { urgency: "soon" } },
      { task_query: { urgency: false } },
      { proposal_query: {}, settings_query: {} },
      {
        proposal: { op: "set_profile", data: { timezone: "UTC" } },
        reminder_query: {},
      },
    ]
  ) {
    await rejects(
      run({ tasks: [], output: { reply: "Hi", ...output } }, "Show saved data"),
    );
  }
});

Deno.test("reminder targets clarify unknown/ambiguous references and reject foreign IDs", async () => {
  const setup = async (kv: Deno.Kv) => {
    for (const n of [50, 51]) {
      await kv.set(["planner", "reminders", owner, id(n)], {
        id: id(n),
        description: "Plan Sunday",
        cron: "0 18 * * 0",
        timezone: "UTC",
        active: true,
        next_run: "2026-10-11T18:00:00.000Z",
      });
    }
    await kv.set(["planner", "reminders", "other", id(52)], {
      id: id(52),
      description: "Foreign Sunday",
    });
  };
  for (const reference of ["Plan Sunday", "Unknown Sunday", id(52)]) {
    const result = await run({
      tasks: [],
      setup,
      output: {
        reply: "Deleted",
        proposal: {
          op: "delete_reminder",
          data: { reminder: reference },
        },
      },
    }, "Delete a reminder");
    assert(result.message.proposal === null);
    assert(String(result.message.content).includes("Nothing has been changed"));
  }
  const selected = await run({
    tasks: [],
    setup,
    output: {
      reply: "Deleted",
      proposal: {
        op: "delete_reminder",
        data: { reminder: id(50) },
      },
    },
  }, `Delete ${id(50)}`);
  assert(
    ((selected.message.proposal as RecordData).data as RecordData).id ===
      id(50),
  );
  assert(selected.message.action_state === "pending");
  const foreignProposal = await run({
    tasks: [],
    setup: async (kv) => {
      await kv.set(["planner", "messages", "other", id(53)], {
        id: id(53),
        proposal: { op: "set_profile", data: { preferences: "Foreign" } },
        action_state: "confirmed",
      });
    },
    output: { reply: "Confirmed", proposal_query: { id: id(53) } },
  }, "Was that confirmed?");
  assert(String(foreignProposal.message.content).includes("No proposal"));
  assert((foreignProposal.message.related_messages as unknown[]).length === 0);
});
