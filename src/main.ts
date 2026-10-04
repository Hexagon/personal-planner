import { createHandler } from "./app.ts";
import { isDenoDeploy, loadConfig } from "./config.ts";
import { runSchedulerTick, startScheduler } from "./scheduler.ts";

const config = loadConfig();
const isDeploy = isDenoDeploy();
if (!isDeploy) {
  await Deno.mkdir("./data", { recursive: true, mode: 0o700 });
  if (Deno.build.os !== "windows") await Deno.chmod("./data", 0o700);
}
const kv = await Deno.openKv(
  isDeploy ? "db://planner-db" : "./data/planner.sqlite3",
);
const scheduler = isDeploy ? undefined : startScheduler(kv);
if (isDeploy) {
  Deno.cron("deliver-reminders", "* * * * *", () => runSchedulerTick(kv));
}
const server = Deno.serve(
  { port: config.port },
  createHandler(config, kv),
);
if (scheduler) {
  Deno.addSignalListener("SIGTERM", () => {
    scheduler.stop();
    void server.shutdown();
  });
}
