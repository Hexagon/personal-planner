import type { Config } from "./config.ts";
import { InputError, type RecordData, uuid } from "./validation.ts";

export class AuthError extends Error {}
export class Database {
  constructor(
    private config: Config,
    private token: string,
    readonly userId: string,
  ) {}

  async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(`${this.config.supabaseUrl}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.config.supabaseKey,
        Authorization: ["Bearer", this.token].join(" "),
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Database request failed");
    return response.status === 204 ? null : response.json();
  }
  list(table: "profiles" | "assets" | "tasks" | "messages" | "reminders") {
    const owner = table === "profiles" ? "id" : "user_id";
    const order = table === "messages" ? "created_at.desc" : "created_at.asc";
    return this.request(
      `${table}?${owner}=eq.${this.userId}&order=${order}&limit=100`,
    ) as Promise<RecordData[]>;
  }
  insert(table: "messages" | "planning_sessions", data: RecordData) {
    return this.request(table, "POST", {
      ...data,
      user_id: this.userId,
    }) as Promise<RecordData[]>;
  }
  async ensureProfile() {
    if (!(await this.list("profiles")).length) {
      await this.request("profiles", "POST", { id: this.userId });
    }
  }
  async owned(table: "assets" | "tasks" | "reminders", id: unknown) {
    const rows = await this.request(
      `${table}?id=eq.${uuid(id)}&user_id=eq.${this.userId}&limit=1`,
    ) as RecordData[];
    if (!rows.length) throw new InputError("Record not found in your account");
    return rows[0];
  }
  confirm(messageId: unknown, cancel: boolean) {
    const id = uuid(messageId);
    if (cancel) {
      return this.request(
        `messages?id=eq.${id}&user_id=eq.${this.userId}&action_state=eq.pending`,
        "PATCH",
        { action_state: "cancelled" },
      );
    }
    return this.request("rpc/confirm_action", "POST", { p_message_id: id });
  }
}
export async function authenticate(
  request: Request,
  config: Config,
): Promise<Database> {
  const authorization = request.headers.get("Authorization") ?? "";
  const parts = authorization.split(" ");
  if (
    parts.length !== 2 || parts[0] !== "Bearer" || !parts[1] ||
    authorization.length > 8192
  ) throw new AuthError();
  const token = authorization.slice(7);
  const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: config.supabaseKey, Authorization: authorization },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new AuthError();
  const user = await response.json();
  try {
    return new Database(config, token, uuid(user.id));
  } catch {
    throw new AuthError();
  }
}
