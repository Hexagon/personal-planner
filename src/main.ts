import { createHandler } from "./app.ts";
import { loadConfig } from "./config.ts";
import { startScheduler } from "./scheduler.ts";

const config = loadConfig();
const kv = await Deno.openKv("./planner.sqlite3");
const scheduler = startScheduler(kv);
const server = Deno.serve(
  { port: config.port },
  createHandler(config, kv),
);
Deno.addSignalListener("SIGTERM", () => {
  scheduler.stop();
  void server.shutdown();
});
