import { createSettings, verifyChatSession } from "./settings.js";
import { createUpcoming } from "./upcoming.js";

const element = (id) => document.getElementById(id);
const notice = (message, tone = "info") => {
  const target = element("notice");
  target.textContent = message;
  target.dataset.tone = tone;
  target.setAttribute("role", tone === "error" ? "alert" : "status");
};
let config;
try {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("Configuration unavailable");
  config = await response.json();
} catch {
  notice("Could not load the app. Refresh the page to try again.", "error");
  throw new Error("App configuration unavailable");
}
element("preview-badge").hidden = !config.preview;
for (const model of config.models) {
  const option = document.createElement("option");
  option.value = model.id;
  option.textContent = model.name;
  element("model").append(option);
}
element("model").value = config.model;
let session = null;
const upcoming = createUpcoming({ api, getOwner: () => session?.user.id });
let busy = false;
const settings = createSettings({
  models: config.models.map((model) => model.id),
  defaultModel: config.model,
});
let openrouterKey = "";
const renderedMessages = new Map();
let pendingCursor = null;
let pendingUser = null;
function sendStatus(message, tone = "info") {
  const target = element("send-status");
  target.textContent = message;
  target.hidden = !message;
  target.dataset.tone = tone;
  target.setAttribute("role", tone === "error" ? "alert" : "status");
  if (tone !== "error") {
    element("send-error").hidden = true;
    element("send-error").open = false;
    element("send-error-details").textContent = "";
  }
}
function requestFailure(error) {
  sendStatus(
    "Couldn’t complete the request. Expand for details. Your draft is kept; check the conversation before retrying.",
    "error",
  );
  const status = Number.isInteger(error?.status)
    ? `HTTP ${error.status}. `
    : "";
  element("send-error-details").textContent = `${status}${
    error?.message ?? "Unknown request error."
  }`.slice(0, 1000);
  element("send-error").hidden = false;
}
function scrollToLatest() {
  element("chat-form").scrollIntoView({ block: "end" });
}

function updateKeyStatus() {
  const mode = settings.snapshot().keyMode;
  element("key-status").textContent = openrouterKey
    ? mode === "device"
      ? "Using your remembered key on this device."
      : mode === "tab"
      ? "Using your key for this tab."
      : "Using your key in memory only; it was not stored."
    : config.serverKeyAvailable
    ? "Using the app-provided key. You can use your own instead."
    : "Add your OpenRouter key to start chatting.";
  element("key-setup").hidden = !!openrouterKey;
  element("change-key").hidden = !openrouterKey;
  element("clear-key").hidden = !openrouterKey;
  element("cancel-key").hidden = !openrouterKey;
}

function updateOnboarding() {
  element("settings").open = !element("consent").checked ||
    (!openrouterKey && !config.serverKeyAvailable);
}

function setSession(value) {
  const previousOwner = session?.user.id;
  session = typeof value?.user?.id === "string" && value.user.id.length
    ? value
    : null;
  const saved = settings.setOwner(session?.user.id);
  openrouterKey = saved.key;
  element("consent").checked = saved.consent;
  element("model").value = saved.model;
  element("reasoning").value = saved.reasoning;
  element("remember-key").checked = saved.keyMode === "device";
  element("login").hidden = !!session;
  element("chat").hidden = !session;
  element("settings").hidden = !session;
  element("logout").hidden = !session;
  if (previousOwner !== session?.user.id) {
    upcoming.reset();
    element("openrouter-key").value = "";
    updateKeyStatus();
    element("messages").replaceChildren();
    renderedMessages.clear();
    pendingCursor = null;
    pendingUser = null;
    element("prompt").value = "";
    element("online-search").checked = false;
    element("timing").textContent = "";
    element("timing").hidden = true;
    sendStatus("");
  }
  element("empty-chat").hidden = renderedMessages.size > 0;
  updateKeyStatus();
  updateOnboarding();
  if (saved.tabClearFailed) {
    notice(
      "Some previous browser credentials could not be removed. Clear this site's browser data before sharing this device.",
      "error",
    );
  }
}
async function api(path, body) {
  if (!session) throw new Error("Please log in");
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new Error(
      "Connection lost. Check your connection and refresh chat before sending again.",
    );
  }
  if (response.status === 401) {
    setSession(null);
    throw new Error("Your session expired. Please sign in again.");
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      "The server returned an unexpected response. Refresh chat before retrying.",
    );
  }
  if (!response.ok) {
    const error = new Error(
      typeof result?.error === "string"
        ? result.error
        : "Request failed. Refresh chat before retrying.",
    );
    error.status = response.status;
    throw error;
  }
  return result;
}
const actionNames = {
  add_task: "Add task",
  update_task: "Update task",
  complete_tasks: "Mark tasks done",
  delete_task: "Delete task",
  set_profile: "Update settings",
  add_reminder: "Add reminder",
  delete_reminder: "Delete reminder",
};
const fieldNames = {
  name: "Name",
  short_description: "Short description",
  full_description: "Full description",
  location_name: "Location",
  priority: "Priority",
  due_date: "Due date",
  status: "Status",
  ids: "Tasks",
  id: "ID",
  timezone: "Timezone",
  preferences: "Preferences",
  description: "Description",
  cron: "Schedule",
  next_run: "Next run",
};
// Untrusted proposal content is rendered as text only.
function describeProposal(proposal) {
  const list = document.createElement("dl");
  const add = (term, value) => {
    const name = document.createElement("dt");
    name.textContent = term;
    const detail = document.createElement("dd");
    detail.textContent = value;
    list.append(name, detail);
  };
  add("Action", actionNames[proposal.op] ?? String(proposal.op));
  for (const [key, value] of Object.entries(proposal.data ?? {})) {
    add(
      fieldNames[key] ?? key,
      value === null
        ? "None"
        : Array.isArray(value)
        ? `${value.length} selected`
        : String(value),
    );
  }
  return list;
}
function render(messages) {
  const container = element("messages");
  for (const message of messages) {
    const previous = renderedMessages.get(message.id);
    if (
      previous && previous.dataset.actionState === String(message.action_state)
    ) {
      continue;
    }
    const article = previous ?? document.createElement("article");
    article.dataset.createdAt = message.created_at;
    article.dataset.messageId = message.id;
    article.replaceChildren();
    article.className = message.role === "user" ? "user" : "assistant";
    const heading = document.createElement("strong");
    heading.textContent = message.role === "user" ? "You" : "Planner";
    const content = document.createElement("p");
    content.textContent = message.content;
    article.append(heading, content);
    if (message.proposal) {
      article.append(describeProposal(message.proposal));
      if (message.action_state === "pending") {
        for (const cancel of [false, true]) {
          const button = document.createElement("button");
          button.textContent = cancel ? "Cancel" : "Confirm";
          button.onclick = () =>
            action(async () => {
              const result = await api("/api/confirm", {
                message_id: message.id,
                cancel,
              });
              await refresh();
              render(
                await api(`/api/messages?id=${encodeURIComponent(message.id)}`),
              );
              if (!result.result) {
                notice(
                  "Proposal status changed elsewhere. See refreshed status.",
                );
              } else {
                notice(
                  cancel
                    ? "Proposal cancelled."
                    : "Confirmation processed. See proposal status.",
                );
              }
            }, cancel ? "Cancelling proposal…" : "Confirming proposal…");
          article.append(button);
        }
      } else {
        const state = document.createElement("p");
        state.className = "message-state";
        state.textContent = message.action_state;
        article.append(state);
      }
    }
    article.dataset.actionState = String(message.action_state);
    if (!previous) {
      renderedMessages.set(message.id, article);
      container.append(article);
    }
  }
  if (!pendingUser) {
    const ordered = [...renderedMessages.values()].sort((a, b) =>
      a.dataset.createdAt.localeCompare(b.dataset.createdAt) ||
      a.dataset.messageId.localeCompare(b.dataset.messageId)
    );
    ordered.forEach((article, index) => {
      if (container.children[index] !== article) {
        container.insertBefore(article, container.children[index] ?? null);
      }
    });
  }
  element("empty-chat").hidden = renderedMessages.size > 0 || !!pendingUser;
}
async function refresh() {
  const upcomingRefresh = upcoming.refresh();
  const messages = await api("/api/messages");
  pendingUser?.remove();
  pendingUser = null;
  render(messages);
  await upcomingRefresh;
}
element("refresh-chat").onclick = () =>
  action(async () => {
    await refresh();
    sendStatus("");
    notice("Chat is up to date. Review the conversation before resending.");
  }, "Refreshing chat…");
element("older-pending").onclick = () =>
  action(async () => {
    const params = new URLSearchParams({ pending: "true" });
    if (pendingCursor) params.set("cursor", pendingCursor);
    const page = await api(`/api/messages?${params}`);
    render(page.messages);
    pendingCursor = page.cursor;
    notice(
      page.cursor
        ? "Page checked. Click again to find older pending proposals."
        : "All history checked. Click again to recheck from the latest page.",
    );
  });
function updateBusy(value) {
  busy = value;
  for (
    const control of document.querySelectorAll(
      "#chat button, #chat textarea, #chat select, #chat input, #settings button, #settings select, #settings input, #logout",
    )
  ) {
    control.disabled = value;
  }
  element("messages").setAttribute("aria-busy", String(value));
}
async function action(callback, progress = "Working…") {
  if (busy) return;
  updateBusy(true);
  notice(progress);
  try {
    await callback();
  } catch (error) {
    notice(
      error.message +
        (settings.snapshot().tabClearFailed
          ? " Some browser credentials could not be cleared. Clear this site's browser data before sharing this device."
          : ""),
      "error",
    );
  } finally {
    updateBusy(false);
    if (element("notice").textContent === progress) notice("");
  }
}
function hiddenField(form, name, value) {
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = name;
  input.value = value;
  form.append(input);
}
async function csrfToken() {
  const response = await fetch("/auth/csrf", { credentials: "same-origin" });
  if (!response.ok) throw new Error("Could not start authentication");
  return (await response.json()).csrfToken;
}
for (const provider of config.providers) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = `Continue with ${provider.name}`;
  button.onclick = async () => {
    try {
      const form = document.createElement("form");
      form.method = "post";
      form.action = `/auth/signin/${encodeURIComponent(provider.id)}`;
      hiddenField(form, "csrfToken", await csrfToken());
      hiddenField(form, "callbackUrl", "/");
      document.body.append(form);
      form.submit();
    } catch {
      notice("Could not start authentication. Please try again.");
    }
  };
  element("auth-providers").append(button);
}
element("save-key").onclick = () => {
  const key = element("openrouter-key").value.trim();
  if (!key) {
    notice("Enter your OpenRouter API key first.", "error");
    return;
  }
  if (key.length > 512) {
    notice("OpenRouter API keys must be 512 characters or fewer.", "error");
    return;
  }
  const result = settings.saveKey(key, element("remember-key").checked);
  openrouterKey = settings.snapshot().key;
  element("openrouter-key").value = "";
  updateKeyStatus();
  updateOnboarding();
  notice(
    !result.cleared
      ? "Using your key, but old browser credentials could not be removed. Clear this site's browser data before sharing this device."
      : !result.stored
      ? "Using your key in memory only. Browser storage is unavailable; it was not saved."
      : element("remember-key").checked
      ? "Your key is remembered for this account on this device."
      : "Your key will be used for chat in this tab only.",
    !result.cleared || !result.stored ? "error" : "info",
  );
};
element("change-key").onclick = () => {
  element("key-setup").hidden = false;
  element("openrouter-key").focus();
};
element("cancel-key").onclick = () => {
  element("openrouter-key").value = "";
  updateKeyStatus();
};
element("clear-key").onclick = () => {
  const cleared = settings.clearKey();
  openrouterKey = "";
  element("openrouter-key").value = "";
  element("remember-key").checked = false;
  updateKeyStatus();
  updateOnboarding();
  notice(
    !cleared
      ? "Key removed from this page, but browser storage could not be cleared. Clear this site's browser data before sharing this device."
      : config.serverKeyAvailable
      ? "Your key was cleared. The app-provided key will be used."
      : "Your key was cleared. Add a key to continue chatting.",
    cleared ? "info" : "error",
  );
};
element("logout").onclick = () =>
  action(async () => {
    const token = await csrfToken();
    const body = new URLSearchParams({ csrfToken: token, callbackUrl: "/" });
    const response = await fetch("/auth/signout", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Could not log out. Please try again.");
    setSession(null);
    element("consent").checked = false;
    if (!settings.snapshot().tabClearFailed) notice("Logged out.");
  });
function temporaryMessage(role, content, className = "") {
  const article = document.createElement("article");
  article.className = `${role} ${className}`;
  const heading = document.createElement("strong");
  heading.textContent = role === "user" ? "You" : "Planner";
  const text = document.createElement("p");
  text.textContent = content;
  article.append(heading, text);
  element("messages").append(article);
  element("empty-chat").hidden = true;
  return article;
}
element("chat-form").onsubmit = (event) => {
  event.preventDefault();
  return action(async () => {
    await verifyChatSession(
      session?.user.id,
      () =>
        fetch("/auth/session", {
          credentials: "same-origin",
          cache: "no-store",
        }),
      (current) => {
        setSession(current);
        element("settings").open = true;
      },
    );
    element("consent").checked = settings.syncConsent();
    if (!element("consent").checked) element("settings").open = true;
    const content = element("prompt").value.trim();
    if (!content) throw new Error("Write a message first.");
    if (!element("consent").checked) {
      element("settings").open = true;
      throw new Error("Please review and accept the AI data notice first.");
    }
    if (!openrouterKey && !config.serverKeyAvailable) {
      element("settings").open = true;
      element("key-setup").hidden = false;
      throw new Error("Add your OpenRouter API key to start chatting.");
    }
    pendingUser?.remove();
    pendingUser = temporaryMessage("user", content);
    const thinking = temporaryMessage("assistant", "Thinking", "thinking");
    sendStatus("Sending your message. Planner is thinking…");
    element("send").textContent = "Sending…";
    scrollToLatest();
    let received = false;
    element("timing").hidden = true;
    try {
      const started = performance.now();
      const message = await api("/api/chat", {
        content,
        model: element("model").value,
        reasoning: element("reasoning").value,
        ai_consent: true,
        online_search: element("online-search").checked,
        ...(openrouterKey ? { openrouter_key: openrouterKey } : {}),
      });
      const roundtrip = Math.round(performance.now() - started);
      const timing = message.timing;
      if (
        Number.isFinite(timing?.provider_ms) && timing.provider_ms >= 0 &&
        Number.isFinite(timing?.application_ms) && timing.application_ms >= 0
      ) {
        element("timing").textContent = `Provider: ${
          Math.round(timing.provider_ms)
        } ms · Application: ${
          Math.round(timing.application_ms)
        } ms · Roundtrip: ${roundtrip} ms`;
        element("timing").hidden = false;
      }
      received = true;
      thinking.remove();
      render([message]);
      render(message.related_messages ?? []);
      pendingCursor = message.pending_cursor;
      element("prompt").value = "";
      element("online-search").checked = false;
      try {
        await refresh();
        sendStatus(
          "Reply received. Any proposed changes still need your confirmation.",
        );
      } catch {
        if (session) {
          sendStatus(
            "Reply received, but history could not refresh. Use Refresh chat; don’t resend this message.",
            "error",
          );
        }
      }
    } catch (error) {
      if (session) {
        try {
          await refresh();
        } catch {
          pendingUser?.remove();
          pendingUser = null;
        }
        element("empty-chat").hidden = renderedMessages.size > 0;
        requestFailure(error);
      } else {
        notice(error.message, "error");
      }
    } finally {
      thinking.remove();
      element("send").textContent = "Send ↑";
      if (session) {
        scrollToLatest();
        element("prompt").disabled = false;
        element("prompt").focus();
      }
      if (!received && !session) sendStatus("");
    }
  }, "");
};
element("prompt").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!busy) element("chat-form").requestSubmit();
  }
};
for (const button of document.querySelectorAll("[data-prompt]")) {
  button.onclick = () => {
    element("prompt").value = button.dataset.prompt;
    element("prompt").focus();
  };
}
element("consent").onchange = () => {
  const stored = settings.setConsent(element("consent").checked);
  updateOnboarding();
  if (!stored) {
    notice(
      "Consent changed for this page only. Browser storage is unavailable; clear this site's browser data if revoking saved consent.",
      "error",
    );
  }
};
globalThis.addEventListener("storage", (event) => {
  if (!settings.handleStorageChange(event.key)) return;
  element("consent").checked = settings.snapshot().consent;
  if (!element("consent").checked) {
    element("settings").open = true;
    notice(
      "AI consent was revoked in another tab. Review Settings before chatting.",
    );
  }
});
for (const id of ["model", "reasoning"]) {
  element(id).onchange = () => {
    if (
      !settings.setPreferences(
        element("model").value,
        element("reasoning").value,
      )
    ) {
      notice(
        "Preferences changed for this page only; they could not be saved.",
        "error",
      );
    }
  };
}
const authError = new URLSearchParams(location.search).get("error");
if (authError === "OAuthAccountNotLinked") {
  notice(
    "This account uses a different sign-in provider. Use the provider you originally chose; accounts are not automatically linked.",
  );
} else if (authError) {
  notice("Sign-in could not be completed. Please try again.");
}
try {
  const response = await fetch("/auth/session", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Session unavailable");
  setSession(await response.json());
  if (session) {
    await refresh();
    if (renderedMessages.size) scrollToLatest();
  }
} catch {
  if (!session) setSession(null);
  notice(
    settings.snapshot().tabClearFailed
      ? "Could not load your session or chat, and some browser credentials could not be cleared. Clear this site's browser data before sharing this device."
      : "Could not load your session or chat. Refresh the page to try again.",
    "error",
  );
}
setInterval(() => {
  if (session && !busy && document.visibilityState === "visible") {
    updateBusy(true);
    refresh().catch(() => {
      if (session) {
        notice("Chat could not sync. Use Refresh chat to try again.", "error");
      }
    }).finally(() => updateBusy(false));
  }
}, 30000);
