import { createOnboarding, validTimezone } from "../public/settings.js";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("settings validate IANA timezones without accepting offsets or untrusted text", () => {
  assert(validTimezone("Europe/Stockholm") === "Europe/Stockholm");
  assert(validTimezone("UTC") === "UTC");
  assert(validTimezone("CET") !== null);
  assert(validTimezone("GMT") !== null);
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

Deno.test("onboarding always uses the current verified account", () => {
  const setup = createOnboarding();
  setup.setOwner("account-a");
  setup.setOwner("account-b");
  const other = setup.snapshot(false, false);
  assert(other.expanded && !other.canChat);
  setup.setOwner(null);
  assert(!setup.snapshot(true, true).canChat);
  assert(!setup.snapshot(true, true).expanded);
  setup.setOwner("account-a");
  const restored = setup.snapshot(true, true);
  assert(!restored.expanded);
});
