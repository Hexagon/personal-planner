import { createHandler } from "./app.ts";
import { loadConfig } from "./config.ts";
import { runSchedulerTick } from "./scheduler.ts";

const config = loadConfig();

Deno.cron("deliver-reminders", "* * * * *", () => runSchedulerTick(config));
Deno.serve(createHandler(config));
