export function createUpcoming({ api, getOwner, onData = (_data) => {} }) {
  const element = (id) => document.getElementById(id);
  const menu = element("upcoming");
  const pane = element("upcoming-pane");
  const badge = element("upcoming-badge");
  const status = element("upcoming-status");
  let dismissed = false;
  let revision = 0;

  function close(focus = false) {
    menu.open = false;
    if (focus) menu.querySelector("summary").focus();
  }
  function show() {
    menu.open = true;
    menu.scrollIntoView({ block: "start", behavior: "instant" });
    menu.querySelector("summary").focus();
  }
  menu.addEventListener("toggle", () => {
    if (menu.open) {
      element("settings").open = false;
      refresh();
    }
  });
  element("settings").addEventListener("toggle", () => {
    if (element("settings").open) close();
  });
  document.addEventListener("click", (event) => {
    if (
      menu.open && !menu.contains(event.target) &&
      !element("show-upcoming").contains(event.target)
    ) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) close(true);
  });
  element("close-upcoming").onclick = () => close(true);
  element("show-upcoming").onclick = show;
  element("hide-upcoming-pane").onclick = () => {
    dismissed = true;
    pane.hidden = true;
    menu.querySelector("summary").focus();
  };
  element("refresh-upcoming").onclick = () => refresh();

  function row(item, compact = false) {
    const li = document.createElement("li");
    li.className = "upcoming-item";
    li.dataset.kind = item.kind;
    const title = document.createElement("span");
    title.className = "upcoming-title";
    title.textContent = `${item.kind === "task" ? "○" : "⏰"} ${item.title}`;
    const detail = document.createElement("span");
    detail.className = "hint";
    if (item.kind === "task") {
      const date = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(`${item.when}T00:00:00Z`));
      detail.textContent = `Task · ${
        item.group === "Today"
          ? "Due today"
          : item.group === "Overdue"
          ? `Overdue · ${date}`
          : `Due ${date}`
      }${item.location ? ` · ${item.location}` : ""}`;
    } else {
      const date = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: item.timezone,
      }).format(new Date(item.when));
      detail.textContent = `Reminder · ${
        item.waiting ? "Awaiting delivery · " : ""
      }${date} · ${item.timezone}`;
    }
    li.append(title, detail);
    if (!compact && item.description) {
      const description = document.createElement("span");
      description.className = "hint";
      description.textContent = item.description;
      li.append(description);
    }
    return li;
  }

  function render(data) {
    const items = data.items;
    const near = items.filter((item) => item.attention);
    badge.textContent = near.length > 99 ? "99+" : String(near.length);
    badge.hidden = near.length === 0;
    menu.querySelector("summary").setAttribute(
      "aria-label",
      `Upcoming reminders and due tasks${
        near.length ? `, ${near.length} need attention` : ""
      }`,
    );
    element("upcoming-preview").replaceChildren(
      ...near.slice(0, 3).map((item) => row(item, true)),
    );
    pane.hidden = dismissed || near.length === 0;
    element("show-upcoming").textContent = `See all upcoming (${items.length})`;
    const list = element("upcoming-list");
    list.replaceChildren();
    for (const group of ["Overdue", "Today", "Tomorrow", "Later"]) {
      const matching = items.filter((item) => item.group === group);
      if (!matching.length) continue;
      const heading = document.createElement("h3");
      heading.textContent = group;
      const ul = document.createElement("ul");
      ul.className = "upcoming-items";
      ul.append(...matching.map((item) => row(item)));
      list.append(heading, ul);
    }
    status.textContent = items.length
      ? `Dates grouped in ${data.timezone}. Reminder times use their saved timezones.`
      : "All clear — no saved reminders or open tasks with a due date. Add one in chat.";
    delete status.dataset.tone;
  }

  async function refresh() {
    const owner = getOwner();
    if (!owner) return;
    const current = ++revision;
    element("refresh-upcoming").disabled = true;
    menu.setAttribute("aria-busy", "true");
    try {
      const data = await api("/api/upcoming");
      if (owner !== getOwner() || current !== revision) return;
      render(data);
      onData(data);
    } catch {
      if (owner !== getOwner() || current !== revision) return;
      pane.hidden = true;
      badge.hidden = true;
      menu.querySelector("summary").setAttribute(
        "aria-label",
        "Upcoming reminders and due tasks",
      );
      element("upcoming-list").replaceChildren();
      status.textContent = "Couldn’t load upcoming items. Try Refresh.";
      status.dataset.tone = "error";
    } finally {
      if (current === revision) {
        element("refresh-upcoming").disabled = false;
        menu.setAttribute("aria-busy", "false");
      }
    }
  }

  function reset() {
    revision++;
    dismissed = false;
    close();
    menu.hidden = !getOwner();
    pane.hidden = true;
    badge.hidden = true;
    badge.textContent = "";
    menu.querySelector("summary").setAttribute(
      "aria-label",
      "Upcoming reminders and due tasks",
    );
    menu.setAttribute("aria-busy", "false");
    element("refresh-upcoming").disabled = false;
    element("upcoming-list").replaceChildren();
    element("upcoming-preview").replaceChildren();
    status.textContent = "Loading…";
    delete status.dataset.tone;
  }
  return { refresh, reset };
}
