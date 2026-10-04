import {
  CONSENT_VERSION,
  createSettings,
  verifyChatSession,
} from "../public/settings.js";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  failRead = false;
  failWrite = false;
  failRemove = false;
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    if (this.failRead) throw new Error("Storage unavailable");
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrite) throw new Error("Quota exceeded");
    this.values.set(key, value);
  }
  removeItem(key: string) {
    if (this.failRemove) throw new Error("Storage unavailable");
    this.values.delete(key);
  }
}

const owner = "google:test-owner";
const other = "github:other-owner";
const scoped = (kind: string, id = owner) =>
  `planner:v1:${kind}:${encodeURIComponent(id)}`;
function setup(
  local = new MemoryStorage(),
  tab = new MemoryStorage(),
) {
  const settings = createSettings({
    local: () => local,
    tab: () => tab,
    models: ["model-a", "model-b"],
    defaultModel: "model-a",
  });
  return { settings, local, tab };
}

Deno.test("settings restore versioned consent, model/reasoning and a tab key on reload", () => {
  const { settings, local, tab } = setup();
  assert(!settings.setConsent(true));
  assert(!settings.saveKey("credential-free-placeholder").stored);
  assert(settings.setOwner(owner).reasoning === "off");
  assert(settings.setConsent(true));
  assert(settings.setPreferences("model-b", "high"));
  assert(settings.saveKey("credential-free-placeholder").stored);
  assert(local.getItem(scoped("key")) === null);
  assert(tab.getItem(scoped("key")) === "credential-free-placeholder");
  const reload = setup(local, tab).settings.setOwner(owner);
  assert(reload.consent && reload.model === "model-b");
  assert(reload.reasoning === "high" && reload.keyMode === "tab");
  assert(reload.key === "credential-free-placeholder");
  assert(settings.setPreferences("model-a", "default"));
  assert(setup(local, tab).settings.setOwner(owner).reasoning === "default");
  const preferences = JSON.parse(local.getItem(scoped("settings"))!);
  assert(preferences.version === 1);
  assert(!("consentVersion" in preferences));
  const consent = JSON.parse(local.getItem(scoped("consent"))!);
  assert(consent.consentVersion === CONSENT_VERSION && consent.accepted);
  assert(!JSON.stringify(preferences).includes("credential-free-placeholder"));
});

Deno.test("verified account switches isolate consent/preferences/keys and erase outgoing tab keys", () => {
  const { settings, local, tab } = setup();
  settings.setOwner(owner);
  settings.setConsent(true);
  settings.setPreferences("model-b", "high");
  settings.saveKey("account-a-placeholder");
  const switched = settings.setOwner(other);
  assert(!switched.consent && !switched.key);
  assert(switched.model === "model-a" && switched.reasoning === "off");
  assert(tab.getItem(scoped("key")) === null);
  settings.saveKey("account-b-placeholder", true);
  const returned = settings.setOwner(owner);
  assert(returned.consent && !returned.key && returned.model === "model-b");
  assert(settings.setOwner(other).key === "account-b-placeholder");
  assert(local.getItem(scoped("key", owner)) === null);
  assert(local.getItem(scoped("key", other)) === "account-b-placeholder");
});

Deno.test("logout clears only tab key; explicit remembered key and consent survive same-account login", () => {
  const { settings, local, tab } = setup();
  settings.setOwner(owner);
  settings.setConsent(true);
  settings.saveKey("tab-placeholder");
  assert(!settings.setOwner(null).key);
  assert(tab.getItem(scoped("key")) === null);
  assert(settings.setOwner(owner).consent);
  assert(!settings.snapshot().key);
  settings.saveKey("device-placeholder", true);
  settings.setOwner(null);
  const reload = setup(local, tab).settings;
  assert(!reload.setOwner(other).key);
  const saved = reload.setOwner(owner);
  assert(saved.consent && saved.key === "device-placeholder");
  assert(saved.keyMode === "device");
});

Deno.test("revocation persists; forgetting and changing back to tab storage removes both key forms", () => {
  const { settings, local, tab } = setup();
  settings.setOwner(owner);
  settings.setConsent(true);
  settings.saveKey("device-placeholder", true);
  assert(settings.setConsent(false));
  assert(!setup(local, tab).settings.setOwner(owner).consent);
  assert(settings.snapshot().key === "device-placeholder");
  settings.saveKey("tab-placeholder");
  assert(local.getItem(scoped("key")) === null);
  assert(tab.getItem(scoped("key")) === "tab-placeholder");
  local.setItem(scoped("key"), "old-device-placeholder");
  assert(settings.clearKey());
  assert(!settings.snapshot().key);
  assert(local.getItem(scoped("key")) === null);
  assert(tab.getItem(scoped("key")) === null);
  assert(!setup(local, tab).settings.setOwner(owner).key);
});

Deno.test("legacy unscoped data, stale consent versions and invalid preferences are not restored", () => {
  const { settings, local, tab } = setup();
  tab.setItem("openrouter-key", "legacy-placeholder");
  local.setItem("openrouter-key", "legacy-placeholder");
  local.setItem(
    scoped("settings"),
    JSON.stringify({
      version: 1,
      consentVersion: CONSENT_VERSION + 1,
      model: "unlisted",
      reasoning: "unlisted",
    }),
  );
  const state = settings.setOwner(owner);
  assert(!state.key && !state.consent);
  assert(tab.getItem("openrouter-key") === null);
  assert(local.getItem("openrouter-key") === null);
  assert(state.model === "model-a" && state.reasoning === "off");
  assert(!settings.setPreferences("unlisted", "high"));
  assert(!settings.setPreferences("model-a", "unlisted"));
  assert(!settings.saveKey(" ").stored);
  assert(!settings.saveKey("x".repeat(513)).stored);
  local.setItem(scoped("settings", other), "{malformed");
  assert(!settings.setOwner(other).consent);
  local.setItem(
    scoped("settings"),
    JSON.stringify({ version: 0, consentVersion: CONSENT_VERSION }),
  );
  assert(!settings.setOwner(owner).consent);
});

Deno.test("storage failures use memory without claiming credentials or preferences were stored", () => {
  const { settings, local, tab } = setup();
  local.failWrite = tab.failWrite = true;
  settings.setOwner(owner);
  assert(!settings.setConsent(true));
  assert(!settings.setPreferences("model-b", "high"));
  assert(!settings.saveKey("memory-placeholder", true).stored);
  assert(settings.snapshot().key === "memory-placeholder");
  assert(settings.snapshot().keyMode === "memory");
  settings.setOwner(other);
  const returned = settings.setOwner(owner);
  assert(returned.consent && returned.model === "model-b");
  assert(returned.keyMode === "memory");
  assert(!setup(local, tab).settings.setOwner(owner).consent);
  assert(!setup(local, tab).settings.setOwner(owner).key);
  local.failRead = tab.failRead = true;
  assert(!setup(local, tab).settings.setOwner(owner).key);
});

Deno.test("failed removals shadow stale credentials and consent while reporting failure", () => {
  const { settings, local, tab } = setup();
  settings.setOwner(owner);
  settings.setConsent(true);
  settings.saveKey("device-placeholder", true);
  tab.setItem(scoped("key"), "tab-placeholder");
  local.failRemove = tab.failRemove = true;
  assert(!settings.clearKey());
  assert(!settings.snapshot().key);
  settings.setOwner(other);
  assert(settings.snapshot().tabClearFailed);
  assert(!settings.setOwner(owner).key);
  local.failWrite = true;
  assert(!settings.setConsent(false));
  settings.setOwner(other);
  assert(!settings.setOwner(owner).consent);
});

Deno.test("blocked storage accessors do not prevent in-memory onboarding or logout", () => {
  const unavailable = () => {
    throw new Error("Blocked storage getter");
  };
  const settings = createSettings({
    local: unavailable,
    tab: unavailable,
    models: ["model-a"],
    defaultModel: "model-a",
  });
  settings.setOwner(owner);
  assert(!settings.setConsent(true));
  assert(!settings.saveKey("memory-placeholder").stored);
  assert(settings.snapshot().keyMode === "memory");
  assert(settings.snapshot().consent);
  const loggedOut = settings.setOwner(null);
  assert(!loggedOut.key && !loggedOut.consent && loggedOut.tabClearFailed);
  assert(!settings.setOwner(other).key);
});
Deno.test("pre-send session verification rejects stale-tab account changes before reading or forwarding credentials", async () => {
  const { settings } = setup();
  settings.setOwner(owner);
  settings.setConsent(true);
  settings.saveKey("account-a-placeholder");
  let currentOwner: string | null = owner;
  let sent = false;
  let readCredentials = false;
  let draft = "account-a-draft";
  let rejected = false;
  try {
    await verifyChatSession(
      currentOwner,
      () => Promise.resolve(Response.json({ user: { id: other } })),
      (session: { user: { id: string } } | null) => {
        currentOwner = session?.user.id ?? null;
        settings.setOwner(currentOwner);
        draft = "";
      },
    );
    readCredentials = true;
    settings.snapshot();
    sent = true;
  } catch {
    rejected = true;
  }
  assert(rejected && !sent && !readCredentials);
  assert(currentOwner === other && !draft);
  assert(!settings.snapshot().key && !settings.snapshot().consent);
});

Deno.test("pre-send session verification fails closed for logout, bad responses and transport errors", async () => {
  const fetchers = [
    () => Promise.resolve(Response.json({})),
    () => Promise.resolve(Response.json({ user: { id: 123 } })),
    () => Promise.resolve(new Response("Unavailable", { status: 503 })),
    () => Promise.resolve(new Response("Not JSON")),
    () => Promise.reject(new Error("Connection lost")),
  ];
  for (const fetchSession of fetchers) {
    const { settings } = setup();
    settings.setOwner(owner);
    settings.setConsent(true);
    settings.saveKey("account-a-placeholder");
    let sent = false;
    let rejected = false;
    try {
      await verifyChatSession(owner, fetchSession, (session: null) => {
        assert(session === null);
        settings.setOwner(null);
      });
      sent = true;
    } catch {
      rejected = true;
    }
    assert(rejected && !sent);
    assert(!settings.snapshot().key && !settings.snapshot().consent);
  }
});

Deno.test("pre-send session verification permits only the unchanged verified owner", async () => {
  let changed = false;
  await verifyChatSession(
    owner,
    () => Promise.resolve(Response.json({ user: { id: owner } })),
    () => {
      changed = true;
    },
  );
  assert(!changed);
});

Deno.test("another tab's preference writes cannot undo consent revocation; pre-send sync and storage events observe it", () => {
  const local = new MemoryStorage();
  const a = setup(local).settings;
  a.setOwner(owner);
  a.setConsent(true);
  const b = setup(local).settings;
  assert(b.setOwner(owner).consent);
  assert(a.setConsent(false));
  assert(b.snapshot().consent);
  assert(b.setPreferences("model-b", "high"));
  assert(!setup(local).settings.setOwner(owner).consent);
  assert(!b.syncConsent());
  assert(!b.snapshot().consent);
  a.setConsent(true);
  assert(b.handleStorageChange(scoped("consent")));
  assert(b.snapshot().consent);
  a.setConsent(false);
  assert(!b.handleStorageChange(scoped("consent", other)));
  assert(b.snapshot().consent);
  assert(b.handleStorageChange(scoped("consent")));
  assert(!b.snapshot().consent);
  a.setConsent(true);
  b.syncConsent();
  local.clear();
  assert(b.handleStorageChange(null));
  assert(!b.snapshot().consent);
});

Deno.test("fresh-page absent or changed sessions remove previous scoped tab credentials without removing remembered keys", () => {
  const { settings, local, tab } = setup();
  settings.setOwner(owner);
  settings.saveKey("remembered-placeholder", true);
  tab.setItem(scoped("key"), "expired-tab-placeholder");
  tab.setItem(scoped("key", other), "another-tab-placeholder");
  const expired = setup(local, tab).settings;
  assert(!expired.setOwner(null).key);
  assert(tab.getItem(scoped("key")) === null);
  assert(tab.getItem(scoped("key", other)) === null);
  assert(local.getItem(scoped("key")) === "remembered-placeholder");
  tab.setItem(scoped("key"), "old-owner-tab-placeholder");
  tab.setItem(scoped("key", other), "current-owner-tab-placeholder");
  const fresh = setup(local, tab).settings.setOwner(other);
  assert(fresh.key === "current-owner-tab-placeholder");
  assert(tab.getItem(scoped("key")) === null);
  assert(tab.getItem(scoped("key", other)) === "current-owner-tab-placeholder");
});

Deno.test("invalid or unreadable dedicated consent fails closed", () => {
  const { settings, local } = setup();
  settings.setOwner(owner);
  settings.setConsent(true);
  local.setItem(
    scoped("consent"),
    JSON.stringify({
      version: 1,
      consentVersion: CONSENT_VERSION + 1,
      accepted: true,
    }),
  );
  assert(!settings.syncConsent());
  local.setItem(scoped("consent"), "{malformed");
  assert(!settings.syncConsent());
  settings.setConsent(true);
  local.failRead = true;
  assert(!settings.syncConsent());
});

Deno.test("legacy unscoped credentials are erased on fresh logout/expiry and clearKey, never restored", () => {
  const { settings, local, tab } = setup();
  tab.setItem("openrouter-key", "legacy-placeholder");
  local.setItem("openrouter-key", "legacy-placeholder");
  assert(!settings.setOwner(null).key);
  assert(tab.getItem("openrouter-key") === null);
  assert(local.getItem("openrouter-key") === null);
  settings.setOwner(owner);
  settings.saveKey("current-placeholder", true);
  tab.setItem("openrouter-key", "legacy-placeholder");
  local.setItem("openrouter-key", "legacy-placeholder");
  assert(settings.clearKey());
  assert(tab.getItem("openrouter-key") === null);
  assert(local.getItem("openrouter-key") === null);
  assert(!settings.snapshot().key);
  tab.setItem("openrouter-key", "legacy-placeholder");
  local.setItem("openrouter-key", "legacy-placeholder");
  settings.setOwner(null);
  assert(tab.getItem("openrouter-key") === null);
  assert(local.getItem("openrouter-key") === null);
});

Deno.test("failed legacy credential removal is reported during startup and forgetting keys without restoring it", () => {
  const { settings, local, tab } = setup();
  tab.setItem("openrouter-key", "legacy-placeholder");
  local.setItem("openrouter-key", "legacy-placeholder");
  tab.failRemove = local.failRemove = true;
  const initial = settings.setOwner(null);
  assert(initial.tabClearFailed && !initial.key);
  const signedIn = settings.setOwner(owner);
  assert(signedIn.tabClearFailed && !signedIn.key);
  assert(!settings.clearKey());
  assert(!settings.snapshot().key);
  assert(tab.getItem("openrouter-key") === "legacy-placeholder");
  assert(local.getItem("openrouter-key") === "legacy-placeholder");
  tab.failRemove = local.failRemove = false;
  assert(!settings.setOwner(owner).tabClearFailed);
  assert(tab.getItem("openrouter-key") === null);
  assert(local.getItem("openrouter-key") === null);
});
