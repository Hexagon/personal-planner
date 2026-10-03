import { createHandler } from "./app.ts";
import { loadConfig } from "./config.ts";
import { runSchedulerTick } from "./scheduler.ts";

const config = loadConfig();
const kv = await Deno.openKv();

Deno.cron("deliver-reminders", "* * * * *", () => runSchedulerTick(kv));
Deno.serve(createHandler(config, kv));
