export const CONSENT_VERSION = 1;
const REASONING = ["off", "high", "default"];

// Failed writes/removals shadow stale storage for the lifetime of this page.
function safeStorage(access) {
  const fallback = new Map();
  return {
    isPersisted(key) {
      return !fallback.has(key);
    },
    read(key) {
      if (fallback.has(key)) return fallback.get(key);
      try {
        return access()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    write(key, value) {
      fallback.set(key, value);
      try {
        const storage = access();
        if (!storage) return false;
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
        fallback.delete(key);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createSettings({
  local = () => globalThis.localStorage,
  tab = () => globalThis.sessionStorage,
  models,
  defaultModel,
}) {
  const persistent = safeStorage(local);
  const temporary = safeStorage(tab);
  let owner = null;
  let state;
  const defaults = () => ({
    consent: false,
    model: defaultModel,
    reasoning: "off",
    key: "",
    keyMode: "memory",
    tabClearFailed: false,
  });
  state = defaults();
  const scoped = (kind) => `planner:v1:${kind}:${encodeURIComponent(owner)}`;
  const snapshot = () => ({ ...state });
  function persistPreferences() {
    if (!owner) return false;
    return persistent.write(
      scoped("settings"),
      JSON.stringify({
        version: 1,
        consentVersion: state.consent ? CONSENT_VERSION : null,
        model: state.model,
        reasoning: state.reasoning,
      }),
    );
  }
  function clearKey() {
    if (!owner) return false;
    const tabCleared = temporary.write(scoped("key"), null);
    const deviceCleared = persistent.write(scoped("key"), null);
    state.key = "";
    state.keyMode = "memory";
    return tabCleared && deviceCleared;
  }
  return {
    snapshot,
    setOwner(id) {
      const next = typeof id === "string" && id.length ? id : null;
      if (next === owner) return snapshot();
      const tabClearFailed = owner
        ? !temporary.write(scoped("key"), null)
        : false;
      owner = next;
      state = defaults();
      state.tabClearFailed = tabClearFailed;
      if (!owner) return snapshot();
      try {
        const saved = JSON.parse(persistent.read(scoped("settings")));
        if (saved?.version === 1) {
          state.consent = saved.consentVersion === CONSENT_VERSION;
          if (models.includes(saved.model)) state.model = saved.model;
          if (REASONING.includes(saved.reasoning)) {
            state.reasoning = saved.reasoning;
          }
        }
      } catch {
        // Missing or malformed settings require onboarding again.
      }
      for (
        const [storage, mode] of [
          [temporary, "tab"],
          [persistent, "device"],
        ]
      ) {
        const key = storage.read(scoped("key"));
        if (typeof key === "string" && key.trim() && key.length <= 512) {
          state.key = key;
          state.keyMode = storage.isPersisted(scoped("key")) ? mode : "memory";
          break;
        }
      }
      return snapshot();
    },
    setConsent(accepted) {
      if (!owner) return false;
      state.consent = accepted === true;
      return persistPreferences();
    },
    setPreferences(model, reasoning) {
      if (!owner || !models.includes(model) || !REASONING.includes(reasoning)) {
        return false;
      }
      state.model = model;
      state.reasoning = reasoning;
      return persistPreferences();
    },
    saveKey(key, remember = false) {
      if (
        !owner || typeof key !== "string" || !key.trim() || key.length > 512
      ) {
        return { stored: false, cleared: false };
      }
      const cleared = clearKey();
      state.key = key.trim();
      const storage = remember ? persistent : temporary;
      const stored = storage.write(scoped("key"), state.key);
      state.keyMode = stored ? (remember ? "device" : "tab") : "memory";
      return { stored, cleared };
    },
    clearKey,
  };
}
