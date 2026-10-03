import type { Config } from "./config.ts";
import { authenticate, AuthError } from "./db.ts";
import { chat } from "./chat.ts";
import { InputError, object } from "./validation.ts";

export function createHandler(config: Config) {
  const active = new Set<string>();
  const files: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
  };
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      `default-src 'self'; connect-src 'self' ${config.supabaseUrl}; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  };
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && files[path]) {
        const [file, type] = files[path];
        return new Response(
          await Deno.readTextFile(
            new URL(`../public/${file}`, import.meta.url),
          ),
          {
            headers: { ...headers, "Content-Type": type },
          },
        );
      }
      if (request.method === "GET" && path === "/api/config") {
        return json({
          supabaseUrl: config.supabaseUrl,
          supabaseKey: config.supabaseKey,
          schedulerEnabled: true,
        });
      }
      if (!["/api/messages", "/api/chat", "/api/confirm"].includes(path)) {
        return json({ error: "Not found" }, 404);
      }
      if (request.method !== (path === "/api/messages" ? "GET" : "POST")) {
        return json({ error: "Method not allowed" }, 405);
      }
      if (
        request.method === "POST" &&
        request.headers.get("Origin") !== config.origin
      ) return json({ error: "Origin not allowed" }, 403);
      const db = await authenticate(request, config);
      if (path === "/api/messages") {
        return json((await db.list("messages")).reverse());
      }
      if (
        !request.headers.get("Content-Type")?.startsWith("application/json")
      ) throw new InputError("JSON required");
      // Bound the body even when Content-Length is absent.
      const reader = request.body?.getReader();
      if (!reader) throw new InputError("Body required");
      let bytes = new Uint8Array(0);
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (bytes.length + chunk.value.length > 16384) {
          await reader.cancel();
          throw new InputError("Request too large");
        }
        const joined = new Uint8Array(bytes.length + chunk.value.length);
        joined.set(bytes);
        joined.set(chunk.value, bytes.length);
        bytes = joined;
      }
      let body;
      try {
        body = object(JSON.parse(new TextDecoder().decode(bytes)));
      } catch {
        throw new InputError("Invalid JSON object");
      }
      if (active.has(db.userId)) {
        return json({ error: "Please wait for your previous request" }, 429);
      }
      active.add(db.userId);
      try {
        if (path === "/api/chat") {
          if (body.ai_consent !== true) {
            throw new InputError(
              "Consent to OpenRouter processing is required",
            );
          }
          return json(await chat(db, config, body.content));
        }
        if (typeof body.cancel !== "boolean") {
          throw new InputError("Confirmation choice required");
        }
        return json({ result: await db.confirm(body.message_id, body.cancel) });
      } finally {
        active.delete(db.userId);
      }
    } catch (error) {
      if (error instanceof AuthError) {
        return json({ error: "Please log in again" }, 401);
      }
      if (error instanceof InputError) {
        return json({ error: error.message }, 400);
      }
      console.error("Planner request failed");
      return json({
        error:
          "Request failed. Refresh chat to check proposal status before retrying.",
      }, 502);
    }
  };
}
