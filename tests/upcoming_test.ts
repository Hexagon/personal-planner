import { createUpcoming } from "../public/upcoming.js";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

class ElementStub {
  hidden = false;
  disabled = false;
  open = false;
  textContent = "";
  dataset: Record<string, string> = {};
  onclick: unknown;
  summary: ElementStub | null = null;
  querySelector() {
    return this.summary ??= new ElementStub();
  }
  setAttribute() {}
  addEventListener() {}
  replaceChildren() {}
}

async function withDocument(run: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const elements = new Map<string, ElementStub>();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, new ElementStub());
        return elements.get(id);
      },
      addEventListener() {},
    },
  });
  try {
    await run();
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

type Data = { timezone: string; items: never[] };

function fixture() {
  let owner = "account-a";
  const pending: Array<(data: Data) => void> = [];
  const accepted: string[] = [];
  const upcoming = createUpcoming({
    api: (path: string) => {
      assert(path === "/api/upcoming");
      return new Promise<Data>((resolve) => pending.push(resolve));
    },
    getOwner: () => owner,
    onData: (data: Data) => {
      accepted.push(data.timezone);
    },
  });
  return {
    upcoming,
    pending,
    accepted,
    switchOwner(next: string) {
      owner = next;
    },
  };
}

Deno.test("superseded upcoming responses cannot overwrite the accepted saved timezone", async () => {
  await withDocument(async () => {
    const { upcoming, pending, accepted } = fixture();
    const older = upcoming.refresh();
    const newer = upcoming.refresh();
    pending[1]({ timezone: "Europe/Stockholm", items: [] });
    await newer;
    assert(accepted.at(-1) === "Europe/Stockholm");
    pending[0]({ timezone: "UTC", items: [] });
    await older;
    assert(accepted.length === 1 && accepted[0] === "Europe/Stockholm");
    assert(accepted.at(-1) === "Europe/Stockholm");
  });
});

Deno.test("account switches reject delayed upcoming data before the data callback", async () => {
  await withDocument(async () => {
    const { upcoming, pending, accepted, switchOwner } = fixture();
    const outgoing = upcoming.refresh();
    switchOwner("account-b");
    pending[0]({ timezone: "UTC", items: [] });
    await outgoing;
    assert(accepted.length === 0);
    const incoming = upcoming.refresh();
    pending[1]({ timezone: "America/New_York", items: [] });
    await incoming;
    assert(accepted.join(",") === "America/New_York");
    assert(accepted.at(-1) === "America/New_York");
    switchOwner("account-a");
  });
});

Deno.test("reset invalidates pending upcoming data even when the owner stays the same", async () => {
  await withDocument(async () => {
    const { upcoming, pending, accepted } = fixture();
    const stale = upcoming.refresh();
    upcoming.reset();
    pending[0]({ timezone: "UTC", items: [] });
    await stale;
    assert(accepted.length === 0);
  });
});
