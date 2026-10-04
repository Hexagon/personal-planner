import { createHandler, isPreviewDeployment } from "./app.ts";
import { loadConfig } from "./config.ts";
import { runSchedulerTick } from "./scheduler.ts";

const config = loadConfig();
const kv = await Deno.openKv();
const preview = isPreviewDeployment(true, Deno.env.get("APP_ENV"));

Deno.cron("deliver-reminders", "* * * * *", () => runSchedulerTick(kv));
Deno.serve(createHandler(config, kv, preview));
