export interface Config {
  supabaseUrl: string;
  supabaseKey: string;
  openrouterKey: string;
  model: string;
  serviceKey?: string;
  origin: string;
  port: number;
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
  const port = Number(Deno.env.get("PORT") ?? 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid PORT");
  }
  return {
    supabaseUrl: supabaseUrl.origin,
    supabaseKey: required("SUPABASE_PUBLISHABLE_KEY"),
    openrouterKey: required("OPENROUTER_API_KEY"),
    model: Deno.env.get("OPENROUTER_MODEL") ?? "openai/gpt-4.1-mini",
    serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || undefined,
    origin,
    port,
  };
}
