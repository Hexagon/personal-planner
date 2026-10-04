const config = await fetch("/api/config").then((response) => response.json());
const element = (id) => document.getElementById(id);
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
const notice = (message) => {
  element("notice").textContent = message;
};

function updateKeyStatus() {
  element("key-status").textContent = openrouterKey
    ? "Using your key for this tab."
    : config.serverKeyAvailable
    ? "Using the app-provided key. You can use your own instead."
    : "Add your OpenRouter key to start chatting.";
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
  }
  updateKeyStatus();
}
async function api(path, body) {
  if (!session) throw new Error("Please log in");
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) setSession(null);
    throw new Error(result.error || "Request failed");
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
            });
          article.append(button);
        }
      } else {
        const state = document.createElement("p");
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
}
async function refresh() {
  render(await api("/api/messages"));
}
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
async function action(callback) {
  if (busy) return;
  busy = true;
  element("send").disabled = true;
  notice("Working…");
  try {
    await callback();
  } catch (error) {
    notice(error.message);
  } finally {
    busy = false;
    element("send").disabled = false;
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
    notice("Enter your OpenRouter API key first.");
    return;
  }
  if (key.length > 512) {
    notice("OpenRouter API keys must be 512 characters or fewer.");
    return;
  }
  openrouterKey = key;
  sessionStorage.setItem("openrouter-key", key);
  element("openrouter-key").value = "";
  updateKeyStatus();
  notice("Your key will be used for chat in this tab only.");
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
element("chat-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    if (!element("consent").checked) {
      throw new Error("Please review and accept the AI data notice first.");
    }
    const message = await api("/api/chat", {
      content: element("prompt").value,
      model: element("model").value,
      ai_consent: true,
      online_search: element("online-search").checked,
      ...(openrouterKey ? { openrouter_key: openrouterKey } : {}),
    });
    render(message.related_messages ?? []);
    pendingCursor = message.pending_cursor;
    element("prompt").value = "";
    element("online-search").checked = false;
    await refresh();
    notice("");
  });
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
    if (session) await refresh();
  }
} catch {
  notice("Could not check your login. Refresh the page to try again.");
}
setInterval(() => {
  if (session && !busy && document.visibilityState === "visible") {
    action(async () => {
      await refresh();
      notice("");
    });
  }
}, 30000);
