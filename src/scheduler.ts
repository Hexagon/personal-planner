import { Cron } from "croner";
import type { Config } from "./config.ts";
import { nextOccurrence, type RecordData } from "./validation.ts";

export function startScheduler(config: Config): Cron | null {
  if (!config.serviceKey) return null;
  const headers = {
    apikey: config.serviceKey,
    Authorization: ["Bearer", config.serviceKey].join(" "),
    "Content-Type": "application/json",
  };
  async function tick() {
    const now = new Date();
    const response = await fetch(
      `${config.supabaseUrl}/rest/v1/reminders?active=eq.true&next_run=lte.${
        encodeURIComponent(now.toISOString())
      }&order=next_run.asc&limit=50`,
      { headers, signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw new Error("Reminder query failed");
    const reminders: RecordData[] = await response.json();
    for (const reminder of reminders) {
      try {
        const next = nextOccurrence(reminder.cron, reminder.timezone, now);
        const delivered = await fetch(
          `${config.supabaseUrl}/rest/v1/rpc/deliver_reminder`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              p_id: reminder.id,
              p_expected_run: reminder.next_run,
              p_next_run: next,
            }),
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!delivered.ok) throw new Error("Delivery failed");
      } catch {
        console.error(
          "A reminder could not be delivered; will retry on next tick",
        );
      }
    }
  }
  const run = async () => {
    try {
      await tick();
    } catch {
      console.error("Reminder polling failed; will retry on next tick");
    }
  };
  // One bounded catch-up message per reminder, skipping older missed occurrences.
  const job = new Cron("* * * * *", { timezone: "UTC", protect: true }, run);
  void job.trigger();
  return job;
}
