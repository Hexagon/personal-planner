import {
  availableModels,
  type Config,
  isAvailableModel,
  isReasoningMode,
} from "./config.ts";
import { authenticate, AuthError, handleAuth } from "./auth.ts";
import { Database } from "./db.ts";
import { chat } from "./chat.ts";
import { InputError, object, text } from "./validation.ts";

export function createHandler(config: Config, kv: Deno.Kv) {
  const active = new Set<string>();
  const oauthCallbacks = new Set([
    ...(config.googleClientId ? ["/auth/callback/google"] : []),
    ...(config.githubClientId ? ["/auth/callback/github"] : []),
  ]);
  const formActions = [
    "'self'",
    ...(config.googleClientId ? ["https://accounts.google.com"] : []),
    ...(config.githubClientId ? ["https://github.com"] : []),
  ].join(" ");
  const files: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/settings.js": ["settings.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
  };
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy":
      `default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action ${formActions}`,
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
      if (
        path.startsWith("/auth/") && ["GET", "POST"].includes(request.method)
      ) {
        if (
          request.method === "POST" &&
          !oauthCallbacks.has(path) &&
          request.headers.get("Origin") !== config.origin
        ) return json({ error: "Origin not allowed" }, 403);
        const response = await handleAuth(request, config);
        for (const [name, value] of Object.entries(headers)) {
          response.headers.set(name, value);
        }
        return response;
      }
      if (request.method === "GET" && path === "/api/config") {
        return json({
          schedulerEnabled: true,
          model: config.model,
          models: availableModels,
          serverKeyAvailable: !!config.openrouterKey,
          providers: [
            ...(config.googleClientId
              ? [{ id: "google", name: "Google" }]
              : []),
            ...(config.githubClientId
              ? [{ id: "github", name: "GitHub" }]
              : []),
          ],
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
      const userId = await authenticate(request, config);
      const db = new Database(kv, userId);
      if (path === "/api/messages") {
        const params = new URL(request.url).searchParams;
        if (params.size) {
          if (params.has("id")) {
            if (params.size !== 1) {
              throw new InputError("Use one message query");
            }
            const message = await db.ownedMessage(params.get("id"));
            return json(message ? [message] : []);
          }
          if (
            [...params.keys()].some((name) =>
              !["cursor", "pending"].includes(name)
            ) ||
            (params.has("pending") && params.get("pending") !== "true")
          ) throw new InputError("Invalid message query");
          const page = await db.messagePage(
            params.get("cursor"),
            params.get("pending") === "true",
          );
          return json({ ...page, messages: page.messages.reverse() });
        }
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
          if (
            body.online_search !== undefined &&
            typeof body.online_search !== "boolean"
          ) {
            throw new InputError("Online search choice must be a boolean");
          }
          const model = body.model ?? config.model;
          if (!isAvailableModel(model)) {
            throw new InputError("Choose a supported model");
          }
          const userKey = body.openrouter_key === undefined
            ? undefined
            : text(body.openrouter_key, 512);
          const reasoning = body.reasoning === undefined
            ? "off"
            : body.reasoning;
          if (!isReasoningMode(reasoning)) {
            throw new InputError("Choose a supported reasoning mode");
          }
          if (!userKey && !config.openrouterKey) {
            throw new InputError("Add an OpenRouter API key to continue");
          }
          return json(
            await chat(
              db,
              config,
              body.content,
              model,
              body.online_search,
              userKey as string | undefined,
              reasoning,
            ),
          );
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
