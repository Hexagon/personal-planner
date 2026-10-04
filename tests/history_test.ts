import { reconcileHistory } from "../public/history.js";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function messages(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, offset) => ({
    id: String(from + offset),
  }));
}

Deno.test("history refresh backfills gaps and preserves older-page progress", async () => {
  const loaded = new Set(messages(106, 205).map((message) => message.id));
  let requestedCursor = "";
  const result = await reconcileHistory(
    { messages: messages(226, 325), cursor: "latest-cursor" },
    true,
    "before-106",
    loaded,
    (cursor: string) => {
      requestedCursor = cursor;
      return { messages: messages(126, 225), cursor: "before-126" };
    },
  );
  assert(requestedCursor === "latest-cursor");
  assert(result.messages.length === 200);
  assert(result.cursor === "before-106");
});

Deno.test("history refresh retains an exhausted cursor when latest messages are loaded", async () => {
  let requested = false;
  const result = await reconcileHistory(
    { messages: messages(1, 100), cursor: "new-cursor" },
    true,
    null,
    new Set(messages(1, 100).map((message) => message.id)),
    () => {
      requested = true;
      return { messages: [], cursor: null };
    },
  );
  assert(!requested);
  assert(result.cursor === null);
});
