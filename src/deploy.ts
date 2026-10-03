import { createHandler } from "./app.ts";
import { loadConfig } from "./config.ts";
import { runSchedulerTick } from "./scheduler.ts";

const config = loadConfig();

Deno.cron("deliver-due-reminders", "* * * * *", () =>
  runSchedulerTick(config)
);
Deno.serve({ port: config.port }, createHandler(config));
