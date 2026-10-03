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
    serviceRole = false,
  ): Promise<unknown> {
    const key = serviceRole ? this.config.serviceKey : this.config.supabaseKey;
    const token = serviceRole ? key : this.token;
    const response = await fetch(`${this.config.supabaseUrl}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: key,
        Authorization: ["Bearer", token].join(" "),
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Database request failed");
    return response.status === 204 ? null : response.json();
  }
  async list(
    table: "profiles" | "tasks" | "messages" | "reminders",
    columns = "*",
  ) {
    const owner = table === "profiles" ? "id" : "user_id";
    const rows: RecordData[] = [];
    const pageSize = 100;
    for (let offset = 0;; offset += pageSize) {
      const records = await this.request(
        `${table}?select=${columns}&${owner}=eq.${this.userId}&order=created_at.desc,id.asc&limit=${pageSize}&offset=${offset}`,
      ) as RecordData[];
      rows.push(...records);
      if (records.length < pageSize || table === "messages") return rows;
    }
  }
  insert(table: "messages", data: RecordData) {
    if (table !== "messages") throw new InputError("Invalid table");
    if (data.role === "assistant") {
      return this.request(
        "rpc/append_assistant_message",
        "POST",
        {
          p_user_id: this.userId,
          p_content: data.content,
          p_proposal: data.proposal ?? null,
        },
        true,
      ) as Promise<RecordData[]>;
    }
    if (data.role !== "user" || data.proposal != null) {
      throw new InputError("Invalid message");
    }
    return this.request("rpc/append_message", "POST", {
      p_role: "user",
      p_content: data.content,
      p_proposal: null,
    }) as Promise<RecordData[]>;
  }
  async ensureProfile() {
    await this.request("rpc/ensure_profile", "POST", {});
  }
  async owned(table: "tasks" | "reminders", id: unknown) {
    const rows = await this.request(
      `${table}?id=eq.${uuid(id)}&user_id=eq.${this.userId}&limit=1`,
    ) as RecordData[];
    if (!rows.length) throw new InputError("Record not found in your account");
    return rows[0];
  }
  async confirm(messageId: unknown, cancel: boolean): Promise<boolean> {
    const id = uuid(messageId);
    return (await this.request(
      `rpc/${cancel ? "cancel_action" : "confirm_action"}`,
      "POST",
      { p_message_id: id },
    )) === true;
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
