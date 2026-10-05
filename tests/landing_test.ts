import type { Config } from "../src/config.ts";
import { createHandler } from "../src/app.ts";
import { canIndex, renderLanding, robots, sitemap } from "../src/landing.ts";

const config: Config = {
  origin: "https://tasks.example",
  port: 8000,
  model: "deepseek/deepseek-v4-flash",
  authSecret: "test-only-placeholder-not-a-real-credential",
  publicIndexing: true,
};

function assert(value: unknown): asserts value {
  if (!value) throw new Error("Assertion failed");
}

Deno.test("only explicit production HTTPS pages can be indexed", () => {
  assert(canIndex(config, false));
  assert(!canIndex(config, true));
  assert(!canIndex({ ...config, publicIndexing: undefined }, false));
  assert(!canIndex({ ...config, publicIndexing: false }, false));
  assert(!canIndex({ ...config, origin: "http://localhost:8000" }, false));
  assert(robots(config, false) === "User-agent: *\nDisallow: /\n");
  const production = robots(config, true);
  assert(production.includes("Disallow: /auth/"));
  assert(production.includes("Disallow: /api/"));
  assert(production.includes("https://tasks.example/sitemap.xml"));
  assert(sitemap(config).includes("<loc>https://tasks.example/</loc>"));
  assert(!sitemap(config).includes("/api/"));
});

Deno.test("landing metadata uses configured origin and discloses access before login", () => {
  const source = "<head>{{PUBLIC_METADATA}}</head><p>{{CHAT_ACCESS}}</p>";
  const ownKey = renderLanding(source, config, true);
  assert(ownKey.includes('href="https://tasks.example/"'));
  assert(ownKey.includes('content="https://tasks.example/social.png"'));
  assert(ownKey.includes('content="index, follow"'));
  assert(ownKey.includes("need your own OpenRouter API key"));
  assert(!ownKey.includes("{{"));
  assert(
    renderLanding(
      "<head>{{ PUBLIC_METADATA }}</head><p>{{ CHAT_ACCESS }}</p>",
      config,
      true,
    ) === ownKey,
  );
  const shared = renderLanding(source, {
    ...config,
    openrouterKey: "server-placeholder",
  }, false);
  assert(shared.includes("This app provides chat access"));
  assert(shared.includes('content="noindex, nofollow"'));
  assert(!shared.includes("server-placeholder"));
  const escaped = renderLanding(source, {
    ...config,
    origin: 'https://tasks.example/"<>&',
  }, false);
  assert(escaped.includes("&quot;&lt;&gt;&amp;"));
  assert(!escaped.includes('example/"<>'));
});

Deno.test("public routes serve binary assets and keep previews and API responses unindexed", async () => {
  const kv = await Deno.openKv(":memory:");
  const readTextFile = Deno.readTextFile;
  const readFile = Deno.readFile;
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  Deno.readTextFile = () =>
    Promise.resolve("<head>{{PUBLIC_METADATA}}</head>{{CHAT_ACCESS}}");
  Deno.readFile = () => Promise.resolve(bytes);
  try {
    const handler = createHandler(config, kv);
    const get = (path: string) =>
      handler(new Request(`https://untrusted.example${path}`));
    const page = await get("/");
    assert(page.headers.get("X-Robots-Tag") === "index, follow");
    const markup = await page.text();
    const canonical = markup.match(/<link rel="canonical" href="([^"]+)">/)
      ?.[1];
    assert(canonical === `${config.origin}/`);
    assert(
      (await get("/?error=OAuth")).headers.get("X-Robots-Tag") ===
        "noindex, nofollow",
    );
    for (const path of ["/social.png", "/favicon.png"]) {
      const response = await get(path);
      assert(response.headers.get("Content-Type") === "image/png");
      const result = new Uint8Array(await response.arrayBuffer());
      assert(result.length === bytes.length);
      assert(result.every((byte, index) => byte === bytes[index]));
      assert(response.headers.get("X-Content-Type-Options") === "nosniff");
      assert(
        response.headers.get("Content-Security-Policy")?.includes(
          "frame-ancestors 'none'",
        ),
      );
    }
    assert(
      (await get("/api/config")).headers.get("X-Robots-Tag") ===
        "noindex, nofollow",
    );
    assert(
      (await get("/api/messages")).headers.get("X-Robots-Tag") ===
        "noindex, nofollow",
    );
    assert(
      (await get("/robots.txt")).headers.get("Content-Type")?.startsWith(
        "text/plain",
      ),
    );
    assert((await get("/sitemap.xml")).status === 200);
    const preview = createHandler(config, kv, true);
    const previewPage = await preview(new Request(`${config.origin}/`));
    assert(previewPage.headers.get("X-Robots-Tag") === "noindex, nofollow");
    assert((await previewPage.text()).includes('content="noindex, nofollow"'));
    const previewRobots = await preview(
      new Request(`${config.origin}/robots.txt`),
    );
    assert(await previewRobots.text() === "User-agent: *\nDisallow: /\n");
    assert(
      (await preview(new Request(`${config.origin}/sitemap.xml`))).status ===
        404,
    );
    assert((await get("/not-allowlisted.png")).status === 404);
  } finally {
    Deno.readTextFile = readTextFile;
    Deno.readFile = readFile;
    kv.close();
  }
});
