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

Deno.test("deferred onboarding allows read-only access but never grants consent or key access", () => {
  const setup = createOnboarding();
  assert(!setup.snapshot(true, true).canChat);
  assert(!setup.snapshot(true, true).canBrowse);
  setup.setOwner("account-a");
  assert(setup.snapshot(false, false).expanded);
  setup.defer();
  const deferred = setup.snapshot(false, false);
  assert(deferred.deferred && !deferred.expanded);
  assert(deferred.canBrowse && !deferred.canChat);
  assert(!setup.snapshot(true, false).canChat);
  assert(!setup.snapshot(false, true).canChat);
  assert(setup.snapshot(true, true).canChat);
  setup.review();
  assert(setup.snapshot(false, false).expanded);
  assert(!setup.snapshot(false, false).deferred);
});

Deno.test("timezone skip and deferral are quiet page-only choices scoped to the verified account", () => {
  const setup = createOnboarding();
  setup.setOwner("account-a");
  setup.skipTimezone();
  setup.defer();
  setup.setTimezone("Europe/Stockholm");
  setup.setOwner("account-b");
  const other = setup.snapshot(false, false);
  assert(!other.deferred && !other.timezoneSkipped && !other.timezone);
  assert(other.expanded && !other.canChat);
  setup.setOwner(null);
  assert(!setup.snapshot(true, true).canChat);
  assert(!setup.snapshot(true, true).expanded);
  setup.setOwner("account-a");
  const restored = setup.snapshot(true, true);
  assert(restored.deferred && restored.timezoneSkipped);
  assert(restored.timezone === "Europe/Stockholm");
  assert(!createOnboarding().snapshot(true, true).deferred);
});

Deno.test("saved timezone is authoritative; invalid data cannot replace it", () => {
  const setup = createOnboarding();
  setup.setOwner("account");
  setup.setTimezone("UTC");
  assert(setup.snapshot(true, true).expanded);
  assert(setup.setTimezone("America/New_York") === "America/New_York");
  assert(setup.snapshot(true, true).timezone === "America/New_York");
  assert(!setup.snapshot(true, true).expanded);
  assert(setup.setTimezone("Invalid/Timezone") === null);
  assert(setup.snapshot(true, true).timezone === "America/New_York");
  setup.review();
  assert(setup.snapshot(true, true).expanded);
  setup.skipTimezone();
  assert(setup.snapshot(true, true).timezoneSkipped);
  assert(setup.snapshot(false, true).expanded);
});

Deno.test("established UTC accounts stay quiet unless consent/key is missing or setup is explicitly reviewed", () => {
  const setup = createOnboarding();
  setup.setOwner("established-account");
  setup.setTimezone("UTC");
  assert(setup.snapshot(true, true).expanded);
  setup.setEstablished(true);
  assert(!setup.snapshot(true, true).expanded);
  assert(setup.snapshot(true, true).timezone === "UTC");
  assert(setup.snapshot(false, true).expanded);
  assert(setup.snapshot(true, false).expanded);
  setup.setEstablished(false);
  assert(!setup.snapshot(true, true).expanded);
  setup.review();
  assert(setup.snapshot(true, true).expanded);
  setup.setOwner("new-account");
  setup.setTimezone("UTC");
  assert(setup.snapshot(true, true).expanded);
  setup.setOwner("established-account");
  setup.defer();
  assert(!setup.snapshot(true, true).expanded);
});
