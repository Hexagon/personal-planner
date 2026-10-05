export const CONSENT_VERSION = 2;
const REASONING = ["off", "high", "default"];

export function validTimezone(value) {
  if (
    typeof value !== "string" || value.length > 100 ||
    !/^[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)
  ) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

export function createOnboarding() {
  let owner = null;
  return {
    setOwner(id) {
      owner = typeof id === "string" && id.length ? id : null;
    },
    snapshot(consent, keyAvailable) {
      const canChat = !!owner && consent === true && keyAvailable === true;
      return {
        canChat,
        canBrowse: !!owner,
        expanded: !!owner && !canChat,
      };
    },
  };
}

export async function verifyChatSession(
  expectedOwner,
  fetchSession,
  setSession,
) {
  let verified;
  try {
    const response = await fetchSession();
    if (!response.ok) throw new Error("Session unavailable");
    verified = await response.json();
    if (
      typeof verified?.user?.id !== "string" || !verified.user.id.length
    ) {
      throw new Error("Session unavailable");
    }
  } catch {
    setSession(null);
    throw new Error(
      "Could not verify your current sign-in. Sign in again before chatting. Your message was not sent.",
    );
  }
  if (!expectedOwner || verified.user.id !== expectedOwner) {
    setSession(verified);
    throw new Error(
      "Your signed-in account changed. Review this account's setup and write a new message. Your message was not sent.",
    );
  }
}

// Failed writes/removals shadow stale storage for the lifetime of this page.
function safeStorage(access) {
  const fallback = new Map();
  return {
    keys() {
      const keys = new Set(fallback.keys());
      try {
        const storage = access();
        if (!storage) return { keys: [...keys], available: false };
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index);
          if (key !== null) keys.add(key);
        }
        return { keys: [...keys], available: true };
      } catch {
        return { keys: [...keys], available: false };
      }
    },
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
  function syncConsent() {
    state.consent = false;
    if (!owner) return false;
    try {
      const saved = JSON.parse(persistent.read(scoped("consent")));
      state.consent = saved?.version === 1 &&
        saved.consentVersion === CONSENT_VERSION && saved.accepted === true;
    } catch {
      // Invalid or inaccessible consent always requires opting in again.
    }
    return state.consent;
  }
  function cleanupTabKeys(verifiedOwner) {
    const { keys, available } = temporary.keys();
    const legacyCleared = cleanupLegacyKeys();
    let cleared = available && legacyCleared;
    const keep = verifiedOwner
      ? `planner:v1:key:${encodeURIComponent(verifiedOwner)}`
      : null;
    for (const key of keys) {
      if (key.startsWith("planner:v1:key:") && key !== keep) {
        const removed = temporary.write(key, null);
        cleared = removed && cleared;
      }
    }
    return cleared;
  }
  function cleanupLegacyKeys() {
    const tabCleared = temporary.write("openrouter-key", null);
    const deviceCleared = persistent.write("openrouter-key", null);
    return tabCleared && deviceCleared;
  }
  function persistPreferences() {
    if (!owner) return false;
    return persistent.write(
      scoped("settings"),
      JSON.stringify({
        version: 1,
        model: state.model,
        reasoning: state.reasoning,
      }),
    );
  }
  function clearKey() {
    const legacyCleared = cleanupLegacyKeys();
    if (!owner) return legacyCleared;
    const tabCleared = temporary.write(scoped("key"), null);
    const deviceCleared = persistent.write(scoped("key"), null);
    state.key = "";
    state.keyMode = "memory";
    return legacyCleared && tabCleared && deviceCleared;
  }
  const settings = {
    snapshot,
    syncConsent,
    handleStorageChange(key) {
      if (!owner || (key !== null && key !== scoped("consent"))) return false;
      syncConsent();
      return true;
    },
    setOwner(id) {
      const next = typeof id === "string" && id.length ? id : null;
      const tabClearFailed = !cleanupTabKeys(next);
      if (next === owner) {
        state.tabClearFailed = tabClearFailed;
        return snapshot();
      }
      owner = next;
      state = defaults();
      state.tabClearFailed = tabClearFailed;
      if (!owner) return snapshot();
      syncConsent();
      try {
        const saved = JSON.parse(persistent.read(scoped("settings")));
        if (saved?.version === 1) {
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
      return persistent.write(
        scoped("consent"),
        JSON.stringify({
          version: 1,
          consentVersion: CONSENT_VERSION,
          accepted: state.consent,
        }),
      );
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
  return {
    ...settings,
    save(
      {
        consent,
        model,
        reasoning,
        key = "",
        remember = false,
        removeKey = false,
      },
    ) {
      if (
        !owner || typeof consent !== "boolean" || !models.includes(model) ||
        !REASONING.includes(reasoning) || typeof key !== "string" ||
        key.length > 512 || typeof remember !== "boolean" ||
        typeof removeKey !== "boolean"
      ) return { valid: false, stored: false, cleared: true };
      const nextKey = key.trim() || (removeKey ? "" : state.key);
      const keyResult = nextKey
        ? settings.saveKey(nextKey, remember)
        : { stored: true, cleared: removeKey ? clearKey() : true };
      const consentStored = settings.setConsent(consent);
      const preferencesStored = settings.setPreferences(model, reasoning);
      return {
        valid: true,
        stored: keyResult.stored && consentStored && preferencesStored,
        cleared: keyResult.cleared,
      };
    },
  };
}
