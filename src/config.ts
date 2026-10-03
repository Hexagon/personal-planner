export interface Config {
  supabaseUrl: string;
  supabaseKey: string;
  openrouterKey: string;
  model: string;
  serviceKey: string;
  origin: string;
  port: number;
}
export const availableModels = [
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
] as const;

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
  const supabaseUrl = new URL(required("SUPABASE_URL"));
  if (
    supabaseUrl.protocol !== "https:" && supabaseUrl.hostname !== "localhost"
  ) {
    throw new Error("Supabase must use HTTPS (except local development)");
  }
  const origin =
    new URL(Deno.env.get("APP_ORIGIN") ?? "http://localhost:8000").origin;
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
    supabaseUrl: supabaseUrl.origin,
    supabaseKey: required("SUPABASE_PUBLISHABLE_KEY"),
    openrouterKey: required("OPENROUTER_API_KEY"),
    model,
    serviceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    origin,
    port,
  };
}
