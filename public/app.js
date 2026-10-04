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
for (const model of config.models) {
  const option = document.createElement("option");
  option.value = model.id;
  option.textContent = model.name;
  element("model").append(option);
}
element("model").value = config.model;
let session = null;
let busy = false;
let openrouterKey = sessionStorage.getItem("openrouter-key") ?? "";
const renderedMessages = new Map();
let pendingCursor = null;
let pendingUser = null;
function sendStatus(message, tone = "info") {
  const target = element("send-status");
  target.textContent = message;
  target.hidden = !message;
  target.dataset.tone = tone;
  target.setAttribute("role", tone === "error" ? "alert" : "status");
}
function scrollToLatest() {
  element("chat-form").scrollIntoView({ block: "end" });
}

function updateKeyStatus() {
  element("key-status").textContent = openrouterKey
    ? "Using your key for this tab."
    : config.serverKeyAvailable
    ? "Using the app-provided key. You can use your own instead."
    : "Add your OpenRouter key to start chatting.";
  element("key-setup").hidden = !!openrouterKey;
  element("change-key").hidden = !openrouterKey;
  element("clear-key").hidden = !openrouterKey;
  element("cancel-key").hidden = !openrouterKey;
}

function setSession(value) {
  session = value?.user?.id ? value : null;
  element("login").hidden = !!session;
  element("chat").hidden = !session;
  element("logout").hidden = !session;
  if (!session) {
    sessionStorage.removeItem("openrouter-key");
    openrouterKey = "";
    element("openrouter-key").value = "";
    updateKeyStatus();
    element("messages").replaceChildren();
    renderedMessages.clear();
    pendingCursor = null;
    pendingUser = null;
    element("prompt").value = "";
    element("consent").checked = false;
    sendStatus("");
  }
  element("empty-chat").hidden = renderedMessages.size > 0;
  updateKeyStatus();
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
    throw new Error(
      typeof result?.error === "string"
        ? result.error
        : "Request failed. Refresh chat before retrying.",
    );
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
  const messages = await api("/api/messages");
  pendingUser?.remove();
  pendingUser = null;
  render(messages);
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
      "#chat button, #chat textarea, #chat select, #chat input, #logout",
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
    notice(error.message, "error");
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
  openrouterKey = key;
  sessionStorage.setItem("openrouter-key", key);
  element("openrouter-key").value = "";
  updateKeyStatus();
  notice("Your key will be used for chat in this tab only.");
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
  sessionStorage.removeItem("openrouter-key");
  openrouterKey = "";
  element("openrouter-key").value = "";
  updateKeyStatus();
  notice(
    config.serverKeyAvailable
      ? "Your key was cleared. The app-provided key will be used."
      : "Your key was cleared. Add a key to continue chatting.",
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
    notice("Logged out.");
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
    const content = element("prompt").value.trim();
    if (!content) throw new Error("Write a message first.");
    if (!element("consent").checked) {
      throw new Error("Please review and accept the AI data notice first.");
    }
    if (!openrouterKey && !config.serverKeyAvailable) {
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
    try {
      const message = await api("/api/chat", {
        content,
        model: element("model").value,
        ai_consent: true,
        online_search: element("online-search").checked,
        ...(openrouterKey ? { openrouter_key: openrouterKey } : {}),
      });
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
        sendStatus(
          `${error.message} Your draft is kept. Check the conversation with Refresh chat before resending; the message may have reached the server.`,
          "error",
        );
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
  if (element("consent").checked) {
    document.querySelector(".privacy").open = false;
  }
};
const authError = new URLSearchParams(location.search).get("error");
if (authError === "OAuthAccountNotLinked") {
  notice(
    "This account uses a different sign-in provider. Use the provider you originally chose; accounts are not automatically linked.",
  );
} else if (authError) {
  notice("Sign-in could not be completed. Please try again.");
}
try {
  const response = await fetch("/auth/session", { credentials: "same-origin" });
  if (response.ok) {
    setSession(await response.json());
    if (session) {
      await refresh();
      if (renderedMessages.size) scrollToLatest();
    }
  }
} catch {
  notice(
    "Could not load your session or chat. Refresh the page to try again.",
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
