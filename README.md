# Personal Planner

A small, chat-first personal/family planner. One Deno server, Deno KV, Auth.js
OAuth, one OpenRouter model, and scheduled reminders. The only interface is
login and chat—including inline confirmations. One account represents one
family's context; there is no cross-account household sharing.

## Setup

1. Install [Deno 2](https://deno.com/). Optionally get an
   [OpenRouter](https://openrouter.ai/) API key for a shared app key, or let
   users bring their own after signing in.
2. Create a Google OAuth client, a GitHub OAuth app, or both. Set the authorized
   callback URL to `<APP_ORIGIN>/auth/callback/google` and/or
   `<APP_ORIGIN>/auth/callback/github` (locally, `http://localhost:8000`).
3. From the repository root, copy `.env.example` to `.env`:

   ```sh
   cp .env.example .env
   ```

   Fill in the values:
   - `AUTH_SECRET`: a random secret with at least 32 bytes, for example
     `openssl rand -base64 32`.
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: set both to enable Google
     sign-in; leave both empty to disable it.
   - `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: set both to enable GitHub
     sign-in; leave both empty to disable it. At least one provider pair is
     required.
   - `OPENROUTER_API_KEY`: optional server-only shared key. Without it, each
     user must enter their own OpenRouter key after signing in. Users can also
     override a shared key with their own.
   - `OPENROUTER_MODEL`: the default model, either `deepseek/deepseek-v4-flash`
     or `deepseek/deepseek-v4-pro` (default: Flash). The chat interface lets
     users choose between these models; availability and pricing depend on
     OpenRouter.
   - `APP_ORIGIN`: exact browser origin, default `http://localhost:8000`. Set
     this to your HTTPS origin when deployed.
   - `PORT`: default `8000`.
4. Start the server from the repository root:

   ```sh
   deno task start
   ```

   Open <http://localhost:8000> and sign in with a configured provider. The
   first sign-in creates that provider identity's planner account; subsequent
   sign-ins must use the same provider. Enter a personal OpenRouter key in chat
   in **Settings** to use it for the current browser tab. By default it is held
   in account-scoped tab session storage and cleared on logout/session expiry.
   Opt into **Remember this key on this device** to keep it across browser
   sessions in account-scoped local storage. Do not enable this on a shared
   device: scripts running on this origin can read browser-stored keys. **Clear
   my key** removes both tab and remembered copies for this account. Keys are
   sent through the app to OpenRouter, but never saved by the server. The
   key-entry box hides once you save a personal key, including after a refresh
   in the same tab. Use **Change key** to replace it. OpenRouter usage is billed
   to the account for the key used. Use `deno task dev` during development.
   Self-hosted deployments need a continuously running process for Croner
   reminders; for Deno Deploy, follow the deployment instructions below.

The local Deno KV database is stored in `data/planner.sqlite3`; it is created
automatically and ignored by Git. Each OAuth provider identity has its own
planner data; Google and GitHub sign-ins are not automatically linked. Auth.js
keeps its signed, encrypted session in an HttpOnly cookie. OAuth credentials,
`AUTH_SECRET`, and any shared OpenRouter key stay server-side. Personal
OpenRouter keys are not stored by the server. Existing Supabase data and
accounts are not imported.

## Checks

Run `deno task fmt`, `deno task lint`, or `deno task test` to check formatting,
lint rules, or tests individually. `deno task check` runs all three along with
type checks for both server entrypoints and the browser app. GitHub Actions runs
the same checks on pushes and pull requests. Tests use in-memory Deno KV and
mock the AI provider; no credentials, network access, or Docker are required.
Tests cover valid and invalid proposals/queries, malformed and truncated JSON,
missing provider content, provider/transport failures, reasoning request
controls, and account-scoped browser settings. They do not measure live model
quality or latency; OAuth and live OpenRouter integration still require manual
testing.

### Deno Deploy

Create a Deno Deploy project from this repository, provision and link a Deno KV
database in the project settings, and set `src/deploy.ts` as its entrypoint.
Both Deploy startup paths call `Deno.openKv()` without arguments; Deploy selects
the linked database automatically, with no connection URL or database
environment variables. If `src/main.ts` is used instead, it detects Deno Deploy
and uses the same connection behavior rather than the local SQLite path.
Self-hosted runs continue to use the local `data/planner.sqlite3` database. If
Deploy reports that the database was not found, verify the database is
provisioned and linked in the project settings. No frontend build is required;
ensure the deployment includes `public/`, which the server reads to serve the
login and chat pages. Configure `AUTH_SECRET`, at least one complete OAuth
client pair, and `APP_ORIGIN` as server-side environment variables or secrets.
Set `OPENROUTER_API_KEY` for an optional shared server-side key; otherwise users
provide their own in Settings. Personal keys use account-scoped tab storage by
default, or persistent device storage with explicit opt-in, and are forwarded to
OpenRouter for chat; the server does not save them. Set `APP_ORIGIN` to the
exact HTTPS origin and register the matching provider callback URL. Configure
OAuth consent and provider-side rate limits. Add rate limiting at a trusted edge
proxy/provider for the app's `/api/chat` and `/api/confirm` routes, and set
provider spending limits for OpenRouter.

The login page uses `Referrer-Policy: same-origin` so browser sign-in form POSTs
retain their Origin header without sending referrers to external sites. Preserve
this policy through any reverse proxy: `no-referrer` can cause form POSTs to
send `Origin: null`, which the app rejects. Sign-in still requires an exact
`APP_ORIGIN` match and a valid Auth.js CSRF token. The form-action content
security policy also allows configured OAuth provider origins so browsers can
follow the sign-in form's authorization redirect.

The deploy entrypoint registers a native `Deno.cron` job that polls a bounded
Deno KV due index every minute. Reminder messages and expected-occurrence
advances are committed in one atomic KV transaction. Cron invocations are
separate from HTTP traffic, so reminder delivery does not depend on an
always-running server.

## Try it in chat

Chat shows your message and a thinking indicator while waiting for a reply.
Press Enter to send or Shift + Enter for a new line. Suggestions only fill the
draft; they do not send it or bypass AI consent. Failed sends keep your draft.
Use **Refresh chat** and review the conversation before resending, since a
connection error does not mean the server did not receive the message. A
received reply is shown even if refreshing the rest of the history fails. Task
and schedule proposals still require their inline confirmation buttons.

**Settings** opens during onboarding until AI consent is accepted and a personal
or app-provided key is available, then collapses to keep chat uncluttered.
Reopen it to change the model/key or revoke consent. Consent is versioned and
remembered on this browser per signed-in account, independently of the key
opt-in; a changed notice version requires acceptance again. Model and reasoning
choices are also remembered per account. If browser storage is unavailable,
settings work in memory but cannot be remembered reliably. Consent revocation is
synchronized across tabs and checked again before sending; changing model
preferences cannot restore revoked consent. Before sending, the app also
rechecks the signed-in account and rejects stale-tab account changes without
forwarding the previous account's key or draft.

Reasoning defaults to **Off** (OpenRouter `reasoning.enabled: false`) for faster
direct answers. **High** requests `reasoning.effort: "high"` and excludes
returned reasoning traces; **Provider default** omits reasoning controls. Both
allowlisted DeepSeek V4 models support thinking/non-thinking modes. See
[OpenRouter reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
and
[DeepSeek thinking modes](https://api-docs.deepseek.com/guides/thinking_mode/).
Routing/provider support and load can vary; lower reasoning does not guarantee a
particular response time. Online search may add latency too.

Successful replies include transient timing measurements: **provider** covers
the OpenRouter fetch and response-body parsing (including network/search time),
while **application** covers saved-context preparation, validation and storage.
Browser round-trip includes network and other request overhead. Compare these
measurements across reasoning modes before attributing slow replies to
reasoning. Timings are not stored in chat history; no keys, chat text or raw
provider responses are logged for measurement.

- “Set my timezone to Europe/Stockholm.”
- “Remember that I should buy milk at ICA.”
- “Add car service at the garage, priority 4, due Friday. Details: ask about the
  brakes and the winter tyres.” (Text after “Details:” in your own words can be
  saved as the full description.)
- “What's urgent?” / “What's at ICA?” / “Show our tasks.” / “What did we
  finish?”
- “Show details of car service.”
- “Raise the priority of milk to 5.” / “Move car service to next Monday.”
- “I've bought milk and the router.” (One confirmation completes both matched
  tasks.)
- “What should we do today?”
- “Remind me every Sunday at 18:00 to plan our week, in Europe/Stockholm.”
- “What timezone and preferences have I saved?” / “Show my reminders.”
- “What still needs confirmation?” / “Show the next page of pending proposals.”
- “Reopen car service.” / “Delete the cancelled task by its ID.”

Review the structured proposal displayed in chat, then **Confirm** or
**Cancel**. Even additions require confirmation. Changing tasks, completing or
deleting them, setting preferences, and creating/removing reminders all use the
same flow. One action is proposed per turn; a completion action can contain up
to 20 tasks and succeeds or fails as a whole. Ambiguous task names require
clarification rather than guessed matches. To change a proposal, cancel it and
ask again with the correction. To alter a reminder, remove it and create a new
one. Updates preserve fields not explicitly changed.

Settings, reminder lists/details and proposal status are rendered from your
account's saved data by code, not invented by the model. Reminder replies show
stable IDs, the complete description, schedule, timezone, active state and next
run; lists have ten-record pages. Task updates/deletions resolve your name or ID
reference server-side across open, done and cancelled tasks. Unknown or
ambiguous references require clarification; finished tasks are not sent
wholesale to AI. Pending proposals are not saved records and chat cannot
confirm/cancel them. Use their inline buttons. **Find older pending proposals**
checks one bounded 100-message history page per click, including after
reloading; continue clicking until the end of history. Asking about pending
proposals also returns usable inline cards and a cursor for the next page.
Confirmation remains transactional and safe to retry.

AI context includes complete saved preferences (up to 4,000 characters) and a
bounded sample of the latest 20 proposal states from the recent 100 messages,
with IDs, operations and safe summaries, never proposal `full_description`
payloads. Absence from that sample does not establish confirmation status.

## Tasks

Everything the planner tracks is a task with a fixed set of fields:

| Field               | Rules                                                          |
| ------------------- | -------------------------------------------------------------- |
| `name`              | Required, 1–80 characters; the task's short name.              |
| `short_description` | Required, 1–160 characters; written by the AI for each change. |
| `full_description`  | Optional, up to 10,000 characters; only your own words.        |
| `location_name`     | Optional plain place label, up to 100 characters.              |
| `priority`          | 1–5, default 3.                                                |
| `due_date`          | Optional date, in your profile timezone.                       |
| `status`            | `open`, `done` or `cancelled`.                                 |
| `created_at`        | Set by the server; `updated_at`/`completed_at` too.            |

- **Urgency** is calculated in code from the due date: `overdue`, `today`,
  `soon` (within 3 days), `later`, or `none`. Open tasks are ordered by priority
  plus an urgency weight, then by due date and creation date.
- **Every open task is sent with every chat message** as a compact row (ID,
  name, short description, location, priority, due date, urgency, created date).
  Finished tasks are not sent; ask for a list of done or cancelled tasks to see
  them.
- **Full descriptions are never sent to the AI.** They are not even read when
  building the AI context. A full description in a proposal must appear in your
  current message (case and spacing may differ); the AI cannot invent or expand
  one. Changing it also requires a new short description. “Show details of …”
  displays it directly from the database, and that reply is replaced by a
  placeholder in later AI context. Text you type in chat is still part of the
  recent chat history the AI sees.
- **At most 300 open tasks per account.** This keeps “all open tasks in context”
  bounded. Complete, cancel or delete tasks to add more; a compare-and-swap KV
  transaction enforces the cap during confirmation.
- Lists (“What's at ICA?”, “What's urgent?”) are rendered by code from saved
  records, filtered by location (case-insensitive), urgency and status. Without
  a location filter, tasks are grouped by location.

## Safety boundaries

- Locations are plain labels. There are no coordinates, geocoding, routes,
  travel times, opening hours, store, or stock lookups. Optional online search
  can find public information but verifies nothing.
- There is no money, budget, cost, or duration tracking, and the app cannot
  purchase anything or perform financial transactions.
- The model can suggest and explain, but cannot execute arbitrary tools or SQL.
  Application validators allow only known fields/actions. The server derives the
  owner from the verified Auth.js session and prefixes every user-data key with
  that owner; client/model-supplied owner IDs are ignored. Confirmation,
  cancellation, the open-task cap, and reminder delivery use atomic KV
  transactions. Confirmation can only transition pending proposals.
- Before sending chat, users must accept a notice that chat, saved timezone and
  complete preferences, reminder summaries, recent proposal states and open
  tasks' names, short descriptions, locations, priorities and dates go through
  OpenRouter and its model provider. Online search is an optional per-message
  choice; when enabled, OpenRouter may send generated search queries to its
  search provider. Search is limited to three results per request. Treat search
  results and AI replies as untrusted suggestions; do not include secrets in
  chat.
- Choose DeepSeek V4 Flash or Pro in chat. The model must return the app's JSON
  reply/proposal format; available actions are proposals, not callable tools,
  and are never saved without inline confirmation. Select **Use online search**
  for a message when current public information is useful; it is off by default.

## Existing data

This version starts with a new Deno KV store and does not import Supabase
accounts, tasks, messages, or reminders. Existing Supabase data remains in that
project; export or back up anything needed before switching providers.

## Reminders

Self-hosted Croner and the Deno Deploy cron job poll once a minute in UTC and
compute each reminder's next occurrence in its IANA timezone. Only five-field
cron expressions are accepted (minute resolution). Each tick processes at most
50 due reminders. The KV transaction checks the reminder's saved version,
derives the owner from its KV key, inserts a chat message, advances its next
run, and updates the due index **atomically**. Concurrent workers/retries cannot
deliver the same occurrence twice.

After downtime, deliver **one** catch-up reminder and skip older missed
occurrences. Invalid schedules are disabled with a generic error log so they
cannot block other users' reminders; remove and recreate them with valid
schedules. Transient delivery failures are retried on the next tick. Reminders
appear in chat (refreshed every 30 seconds while visible), not email/push
notifications. Scheduled planning is a prompt to open chat and plan; it never
invokes AI or changes tasks unattended.

## Development and checks

```sh
deno task check
```

This runs formatting, linting, server/browser syntax/type checks, and Deno
tests. Tests use in-memory Deno KV and a mocked AI provider—no credentials or
paid AI requests are needed. They exercise OAuth sessions, ownership scoping,
request limits, proposal validation, full-description isolation, atomic
confirmation and task-cap behavior, reminder idempotency, deterministic
urgency/lists, and Croner timezones.

For a live deployment, use two test accounts to verify separate chat/tasks,
confirm and cancel proposals, and schedule a minute-level reminder. On Deno
Deploy, verify the cron job is registered and that overlapping or retried
invocations produce only one reminder message for an occurrence. OAuth and
OpenRouter integration require your own credentials and should be checked before
exposing the deployment.

The conversational regressions mock structured model outputs: they verify the
request paths, validation, saved-record selection and confirmation boundaries,
not a live model's accuracy at understanding every phrase or typo.

### Modules

- `src/app.ts`, `src/main.ts`: native HTTP server and API boundaries.
- `src/auth.ts`: Auth.js OAuth providers, session cookies, and verification.
- `src/db.ts`: owner-scoped Deno KV records and atomic operations.
- `src/chat.ts`: one bounded model request with three focused internal roles.
- `src/planner/`: urgency and priority ordering, location grouping, task lists,
  details and reference resolution.
- `src/validation.ts`: allowlisted inputs and Croner schedule validation.
- `src/scheduler.ts`: bounded polling and transactional reminder delivery;
  `src/deploy.ts` registers the Deno Deploy cron trigger.
- `public/`: dependency-free login/chat UI.
- `data/planner.sqlite3`: local Deno KV database (created automatically; ignored
  by Git).

No agent framework, autonomous loops, frontend build step, or database service
is required. OAuth and the AI provider remain external services. The per-account
in-flight request guard is in-memory and only applies within one server
instance; it does not coordinate requests across Deno Deploy instances. Use edge
rate limiting for public routes and rely on the KV's transactional
confirmation/delivery operations for cross-instance safety. Requests use one
model call, at most 1,800 output tokens, a 30-second AI timeout, and one active
mutation/chat request per account per process. Context contains every open task
(at most 300) as compact rows, up to 100 reminders, and 12 recent messages; full
descriptions and finished tasks are excluded. Lists show at most 300 tasks. This
is a small family planner, not an unbounded archive. Add external rate limits
and provider spending limits as appropriate. Logs intentionally omit
credentials, provider responses, and chat content.

MIT licensed; see `LICENSE`.
