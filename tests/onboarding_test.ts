import { createOnboarding, validTimezone } from "../public/settings.js";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("onboarding validates IANA timezone suggestions without accepting offsets or untrusted text", () => {
  assert(validTimezone("Europe/Stockholm") === "Europe/Stockholm");
  assert(validTimezone("UTC") === "UTC");
  assert(validTimezone("CET") !== null);
  assert(validTimezone("GMT") !== null);
  const setup = createOnboarding();
  setup.setOwner("account");
  const alias = setup.setTimezone("CET");
  assert(alias !== null && setup.snapshot(true, true).timezone === alias);
  for (
    const value of [
      null,
      123,
      "",
      "+02:00",
      "UTC+2",
      "Not/AZone",
      " Europe/Paris",
      "<script>",
      "Europe/Paris\n",
      "A".repeat(101),
    ]
  ) {
    assert(validTimezone(value) === null, String(value));
  }
});

Deno.test("settings automatically open when either consent or chat access is missing", () => {
  const setup = createOnboarding();
  assert(!setup.snapshot(true, true).canChat);
  assert(!setup.snapshot(true, true).canBrowse);
  setup.setOwner("account-a");
  assert(setup.snapshot(false, false).expanded);
  assert(setup.snapshot(false, false).canBrowse);
  assert(!setup.snapshot(false, false).canChat);
  assert(!setup.snapshot(true, false).canChat);
  assert(!setup.snapshot(false, true).canChat);
  assert(setup.snapshot(true, true).canChat);
  assert(!setup.snapshot(true, true).expanded);
  assert(setup.snapshot(false, false).expanded);
  assert(setup.snapshot(true, false).expanded);
  assert(setup.snapshot(false, true).expanded);
});

Deno.test("timezone hints are page-only and scoped to the verified account", () => {
  const setup = createOnboarding();
  setup.setOwner("account-a");
  setup.setTimezone("Europe/Stockholm");
  setup.setOwner("account-b");
  const other = setup.snapshot(false, false);
  assert(!other.timezone);
  assert(other.expanded && !other.canChat);
  setup.setOwner(null);
  assert(!setup.snapshot(true, true).canChat);
  assert(!setup.snapshot(true, true).expanded);
  setup.setOwner("account-a");
  const restored = setup.snapshot(true, true);
  assert(restored.timezone === "Europe/Stockholm");
  assert(!restored.expanded);
});

Deno.test("saved timezone is authoritative; invalid data cannot replace it", () => {
  const setup = createOnboarding();
  setup.setOwner("account");
  setup.setTimezone("UTC");
  assert(!setup.snapshot(true, true).expanded);
  assert(setup.setTimezone("America/New_York") === "America/New_York");
  assert(setup.snapshot(true, true).timezone === "America/New_York");
  assert(!setup.snapshot(true, true).expanded);
  assert(setup.setTimezone("Invalid/Timezone") === null);
  assert(setup.snapshot(true, true).timezone === "America/New_York");
  assert(setup.snapshot(false, true).expanded);
});

Deno.test("optional timezone never triggers onboarding for a ready account", () => {
  const setup = createOnboarding();
  setup.setOwner("established-account");
  assert(!setup.snapshot(true, true).expanded);
  setup.setTimezone("UTC");
  assert(!setup.snapshot(true, true).expanded);
  assert(setup.snapshot(true, true).timezone === "UTC");
  assert(setup.snapshot(false, true).expanded);
  assert(setup.snapshot(true, false).expanded);
  assert(!setup.snapshot(true, true).expanded);
  setup.setOwner("new-account");
  setup.setTimezone("UTC");
  assert(!setup.snapshot(true, true).expanded);
  setup.setOwner("established-account");
  assert(!setup.snapshot(true, true).expanded);
});
