export interface Config {
  openrouterKey?: string;
  model: string;
  authSecret: string;
  googleClientId?: string;
  googleClientSecret?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  origin: string;
  port: number;
}
export const availableModels = [
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
] as const;

export const reasoningModes = ["off", "high", "default"] as const;
export type ReasoningMode = typeof reasoningModes[number];

export function isReasoningMode(value: unknown): value is ReasoningMode {
  return typeof value === "string" &&
    reasoningModes.some((mode) => mode === value);
}

export function isAvailableModel(
  value: unknown,
): value is typeof availableModels[number]["id"] {
  return typeof value === "string" &&
    availableModels.some((model) => model.id === value);
}

export function loadConfig(): Config {
  const required = (name: string) => {
    const value = Deno.env.get(name);
    if (!value) throw new Error(`Missing environment variable: ${name}`);
    return value;
  };
  const authSecret = required("AUTH_SECRET");
  if (new TextEncoder().encode(authSecret).length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 bytes");
  }
  const appOrigin = new URL(
    Deno.env.get("APP_ORIGIN") ?? "http://localhost:8000",
  );
  if (
    appOrigin.protocol !== "https:" &&
    (appOrigin.protocol !== "http:" || appOrigin.hostname !== "localhost")
  ) {
    throw new Error("APP_ORIGIN must use HTTPS (except localhost)");
  }
  if (
    appOrigin.pathname !== "/" || appOrigin.search || appOrigin.hash ||
    appOrigin.username || appOrigin.password
  ) {
    throw new Error(
      "APP_ORIGIN must be an origin without a path or credentials",
    );
  }
  const origin = appOrigin.origin;
  const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const githubClientId = Deno.env.get("GITHUB_CLIENT_ID");
  const githubClientSecret = Deno.env.get("GITHUB_CLIENT_SECRET");
  if (!!googleClientId !== !!googleClientSecret) {
    throw new Error("Configure both Google OAuth environment variables");
  }
  if (!!githubClientId !== !!githubClientSecret) {
    throw new Error("Configure both GitHub OAuth environment variables");
  }
  if (!googleClientId && !githubClientId) {
    throw new Error("Configure at least one OAuth provider");
  }
  const model = Deno.env.get("OPENROUTER_MODEL") ??
    availableModels[0].id;
  if (!isAvailableModel(model)) {
    throw new Error("OPENROUTER_MODEL must be a supported DeepSeek model");
  }
  const port = Number(Deno.env.get("PORT") ?? 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid PORT");
  }
  return {
    ...(Deno.env.get("OPENROUTER_API_KEY")
      ? { openrouterKey: Deno.env.get("OPENROUTER_API_KEY") }
      : {}),
    model,
    authSecret,
    ...(googleClientId && googleClientSecret
      ? { googleClientId, googleClientSecret }
      : {}),
    ...(githubClientId && githubClientSecret
      ? { githubClientId, githubClientSecret }
      : {}),
    origin,
    port,
  };
}
