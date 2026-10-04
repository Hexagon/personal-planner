import { Cron } from "croner";
import { deliverReminder, dueReminders, quarantineReminder } from "./db.ts";
import { InputError, nextOccurrence } from "./validation.ts";

export async function runSchedulerTick(kv: Deno.Kv): Promise<void> {
  try {
    const reminders = await dueReminders(kv, new Date().toISOString(), 50);
    for (const reminder of reminders) {
      try {
        const nextRun = nextOccurrence(
          reminder.row.cron,
          reminder.row.timezone,
          new Date(),
        );
        await deliverReminder(kv, reminder, nextRun);
      } catch (error) {
        if (error instanceof InputError) {
          await quarantineReminder(kv, reminder);
          console.error(
            "An invalid reminder was disabled; recreate it with a valid schedule",
          );
        } else {
          console.error(
            "A reminder could not be delivered; will retry on next tick",
          );
        }
      }
    }
  } catch {
    console.error("Reminder polling failed; will retry on next tick");
  }
}

export function startScheduler(kv: Deno.Kv): Cron {
  // One bounded catch-up message per reminder, skipping older missed occurrences.
  const job = new Cron(
    "* * * * *",
    { timezone: "UTC", protect: true },
    () => runSchedulerTick(kv),
  );
  void job.trigger();
  return job;
}
