const config = await fetch("/api/config").then((response) => response.json());
const element = (id) => document.getElementById(id);
let session = null;
let busy = false;
const renderedMessages = new Map();
const notice = (message) => {
  element("notice").textContent = message;
};

async function auth(path, body) {
  const response = await fetch(`${config.supabaseUrl}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: config.supabaseKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(
      "Authentication failed. Check your credentials or confirmation email.",
    );
  }
  return result;
}
function setSession(value) {
  session = value?.access_token
    ? { ...value, expires_at: Date.now() + value.expires_in * 1000 }
    : null;
  element("login").hidden = !!session;
  element("chat").hidden = !session;
  element("logout").hidden = !session;
  if (!session) {
    element("messages").replaceChildren();
    renderedMessages.clear();
  }
}
async function api(path, body) {
  if (!session) throw new Error("Please log in");
  if (session.expires_at < Date.now() + 60000) {
    try {
      setSession(
        await auth("token?grant_type=refresh_token", {
          refresh_token: session.refresh_token,
        }),
      );
    } catch {
      setSession(null);
      throw new Error("Session expired. Please log in again.");
    }
  }
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: ["Bearer", session.access_token].join(" "),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) setSession(null);
    throw new Error(result.error || "Request failed");
  }
  return result;
}
function render(messages) {
  const container = element("messages");
  for (const message of messages) {
    const previous = renderedMessages.get(message.id);
    if (previous && previous.dataset.actionState === String(message.action_state)) {
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
      const details = document.createElement("pre");
      details.textContent = JSON.stringify(message.proposal, null, 2);
      article.append(details);
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
              if (!result.result) {
                notice(
                  "Proposal status changed elsewhere. See refreshed status.",
                );
              } else {
                notice(cancel
                  ? "Proposal cancelled."
                  : "Confirmation processed. See proposal status.");
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
element("login-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    setSession(
      await auth("token?grant_type=password", {
        email: element("email").value,
        password: element("password").value,
      }),
    );
    element("password").value = "";
    await refresh();
    notice(
      config.schedulerEnabled
        ? "Welcome. Reminders are enabled."
        : "Welcome. Reminders are disabled on this deployment.",
    );
  });
};
element("signup").onclick = () =>
  action(async () => {
    if (!element("login-form").reportValidity()) return;
    const result = await auth("signup", {
      email: element("email").value,
      password: element("password").value,
    });
    element("password").value = "";
    setSession(result);
    if (session) await refresh();
    notice(
      session
        ? "Welcome!"
        : "Check your email to confirm your account, then log in.",
    );
  });
element("logout").onclick = () =>
  action(async () => {
    const token = session?.access_token;
    setSession(null);
    element("consent").checked = false;
    if (token) {
      await fetch(`${config.supabaseUrl}/auth/v1/logout`, {
        method: "POST",
        headers: {
          apikey: config.supabaseKey,
          Authorization: ["Bearer", token].join(" "),
        },
      });
    }
    notice("Logged out.");
  });
element("chat-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    if (!element("consent").checked) {
      throw new Error("Please review and accept the AI data notice first.");
    }
    await api("/api/chat", {
      content: element("prompt").value,
      ai_consent: true,
    });
    element("prompt").value = "";
    await refresh();
    notice("");
  });
};
setInterval(() => {
  if (session && !busy && document.visibilityState === "visible") {
    action(async () => {
      await refresh();
      notice("");
    });
  }
}, 30000);
