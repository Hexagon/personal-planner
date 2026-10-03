import { chat } from "../src/chat.ts";
import { Database } from "../src/db.ts";
import type { Config } from "../src/config.ts";

Deno.test("large context remains manageable and partial updates preserve unmodified notes", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const assets = Array.from({ length: 100 }, (_, index) => ({
    id: index === 0
      ? id
      : `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    description: `Bike ${index}`,
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
        JSON.stringify(context).length > 120000 || context.assets.length !== 100
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
    if (url.includes("/assets?id=")) return json([assets[0]]);
    if (url.includes("/assets?")) return json(assets);
    if (init?.method === "POST") {
      if (!url.endsWith("/messages")) throw new Error("Unexpected mutation");
      return json([{ ...JSON.parse(String(init.body)), id }]);
    }
    return json([]);
  };
  try {
    const message = await chat(
      new Database(config, "test-session", id),
      config,
      "Change Bike 0 value to $500",
    );
    const proposal = message.proposal as { data: Record<string, unknown> };
    if (
      proposal.data.notes !== assets[0].notes ||
      proposal.data.description !== assets[0].description ||
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
