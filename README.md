# Personal Planner

A small, chat-first personal/family planner. One Deno server, Supabase
Auth/Postgres, one OpenRouter model, and scheduled reminders. The only interface
is login and chat—including inline confirmations. One account represents one
family's context; there is no cross-account household sharing.

## Setup

1. Install [Deno 2](https://deno.com/), create a
   [Supabase](https://supabase.com/) project, and get an
   [OpenRouter](https://openrouter.ai/) API key.
2. Apply the SQL files in `supabase/migrations/` in filename order using the
   Supabase SQL editor. Alternatively, install the
   [Supabase CLI](https://supabase.com/docs/guides/cli), then log in, link this
   repository to your project using its project ref (replace the placeholder
   below), and push the migrations:

   ```sh
   supabase login
   supabase link --project-ref <project-ref>
   supabase db push
   ```

   Existing installations should apply only migrations not yet applied.
3. In Supabase, enable email/password authentication. Set the Auth Site URL and
   allowed email-confirmation redirect URL to your app's origin
   (`http://localhost:8000` locally). After signup, users confirm their email
   and log in with their password.
4. From the repository root, copy `.env.example` to `.env`:

   ```sh
   cp .env.example .env
   ```

   Fill in the values. Find the project URL and API keys in your Supabase
   project settings:
   - `SUPABASE_URL`: your project URL.
   - `SUPABASE_PUBLISHABLE_KEY`: public publishable key or legacy anon key.
     **Never put a secret/service-role key here.**
   - `OPENROUTER_API_KEY`: server-only API key.
   - `OPENROUTER_MODEL`: the default model, either `deepseek/deepseek-v4-flash`
     or `deepseek/deepseek-v4-pro` (default: Flash). The chat interface lets
     users choose between these models; availability and pricing depend on
     OpenRouter.
   - `SUPABASE_SERVICE_ROLE_KEY`: required server-only legacy service-role key.
     It is used only by the Deno server for trusted assistant messages and
     unattended reminders; never expose it to the browser.
   - `APP_ORIGIN`: exact browser origin, default `http://localhost:8000`. Set
     this to your HTTPS origin when deployed.
   - `PORT`: default `8000`.
5. Start the server from the repository root:

   ```sh
   deno task start
   ```

   Open <http://localhost:8000>, create an account, confirm the email if
   required, and log in. Use `deno task dev` during development. Self-hosted
   deployments need a continuously running process for Croner reminders; for
   Deno Deploy, follow the deployment instructions below.

Credentials belong to each self-hosting deployment, not individual app accounts.
The browser receives only the Supabase URL and public key. Auth tokens are held
in memory, not local storage; reloading requires login. `.env` is ignored by
Git.

## Checks

Run `deno task fmt`, `deno task lint`, or `deno task test` to check formatting,
lint rules, or tests individually. `deno task check` runs all three along with
type checks for both server entrypoints and the browser app. GitHub Actions runs
this full check on pushes and pull requests, then starts the local Supabase
database, applies migrations, runs pgTAP tests, and verifies generated database
types are up to date. The app tests mock external providers and require no
credentials; database CI requires Docker.

### Deno Deploy

Create a Deno Deploy project from this repository and set `src/deploy.ts` as its
entrypoint. No frontend build is required; ensure the deployment includes
`public/`, which the server reads to serve the login and chat pages. Configure
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `OPENROUTER_API_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, and `APP_ORIGIN` as server-side environment
variables/secrets in the project settings. Set `APP_ORIGIN` to the exact HTTPS
origin. Never expose the OpenRouter or service-role key to client-side code.

Set the Supabase Auth Site URL to the deployed origin and allow the appropriate
email-confirmation redirect URLs. Configure Supabase SMTP, signup restrictions,
and Auth rate limits for public use. Add rate limiting at a trusted edge
proxy/provider for the app's `/api/chat` and `/api/confirm` routes, and set
provider spending limits for OpenRouter.

The deploy entrypoint registers a native `Deno.cron` job that polls due
reminders every minute. The same bounded query and atomic `deliver_reminder` RPC
are used as in self-hosted mode. Cron invocations are separate from HTTP
traffic, so reminder delivery does not depend on an always-running server.

## Try it in chat

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

Review the structured proposal displayed in chat, then **Confirm** or
**Cancel**. Even additions require confirmation. Changing tasks, completing or
deleting them, setting preferences, and creating/removing reminders all use the
same flow. One action is proposed per turn; a completion action can contain up
to 20 tasks and succeeds or fails as a whole. Ambiguous task names require
clarification rather than guessed matches. To change a proposal, cancel it and
ask again with the correction. To alter a reminder, remove it and create a new
one. Updates preserve fields not explicitly changed.

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
| `created_at`        | Set by the database; `updated_at`/`completed_at` too.          |

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
  bounded. Complete, cancel or delete tasks to add more; the database enforces
  the cap during confirmation.
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
  Application validators allow only known fields/actions. Authenticated users
  have read-only table access and can append only their own user messages.
  Confirmation/cancellation use owner-validated RPCs; trusted assistant messages
  are written server-side with the privileged key. Confirmation can only
  transition pending proposals. Database constraints and ownership policies
  provide another boundary.
- Before sending chat, users must accept a notice that chat and open tasks'
  names, short descriptions, locations, priorities and dates go through
  OpenRouter and its model provider. Online search is an optional per-message
  choice; when enabled, OpenRouter may send generated search queries to its
  search provider. Search is limited to three results per request. Treat search
  results and AI replies as untrusted suggestions; do not include secrets in
  chat.
- Choose DeepSeek V4 Flash or Pro in chat. The model must return the app's JSON
  reply/proposal format; available actions are proposals, not callable tools,
  and are never saved without inline confirmation. Select **Use online search**
  for a message when current public information is useful; it is off by default.

## Upgrading from the asset/budget version

Migration `202610030003_tasks_only.sql` **permanently deletes all assets** and
removes budget, currency, starting location, cost, duration, coordinates,
categories, destinations and next-trip data. Export anything you need first, for
example in the Supabase SQL editor:

```sql
select * from public.assets;
select id, description, location, estimated_cost_minor, duration_minutes
from public.tasks;
```

Existing tasks are kept: the old description becomes the name (first 80
characters) and short description (first 160 characters). Descriptions longer
than 160 characters are also kept as the full description. The old location
label becomes the location name. Pending proposals are cancelled.

## Reminders

Self-hosted Croner and the Deno Deploy cron job poll once a minute in UTC and
compute each reminder's next occurrence in its IANA timezone. Only five-field
cron expressions are accepted (minute resolution). Each tick processes at most
50 due reminders. The database locks the reminder, verifies its expected
occurrence, inserts a chat message scoped to its saved owner, and advances its
next run **atomically**. Concurrent workers/retries cannot deliver the same
occurrence twice.

After downtime, deliver **one** catch-up reminder and skip older missed
occurrences. Invalid schedules are disabled with a generic error log so they
cannot block other users' reminders; remove and recreate them with valid
schedules. Transient delivery failures are retried on the next tick. Reminders
appear in chat (refreshed every 30 seconds while visible), not email/push
notifications. Scheduled planning is a prompt to open chat and plan; it never
invokes AI or changes tasks unattended. The server-side privileged key is
required for assistant replies and reminder delivery; it is never sent to the
browser.

## Development and checks

```sh
deno task check
```

This runs formatting, linting, server/browser syntax/type checks, and Deno
tests. Tests use mocked HTTP providers—no credentials, network permissions, or
paid AI requests are needed. They exercise authorization, ownership scoping,
request limits, proposal validation, full-description isolation, the open-task
cap, deterministic urgency/lists, and Croner timezones. The database migration
was additionally exercised against PostgreSQL for RLS, transaction rollback,
concurrent confirmations, and duplicate reminder delivery.

For a live deployment, use two test accounts to verify separate chat/tasks,
confirm and cancel proposals, and schedule a minute-level reminder. On Deno
Deploy, verify the cron job is registered and that overlapping or retried
invocations produce only one reminder message for an occurrence. Real Supabase
and OpenRouter integration requires your own credentials and should be checked
before exposing the deployment.

The conversational regressions mock structured model outputs: they verify the
request paths, validation, saved-record selection and confirmation boundaries,
not a live model's accuracy at understanding every phrase or typo. Database
ownership/input/cap/atomicity tests are in `supabase/tests/tasks.sql`; run them
locally with Docker and the Supabase CLI:

```sh
supabase db start
supabase test db
```

The tests use pgTAP and roll back their fixtures. Regenerate
`src/database.types.ts` with `supabase gen types typescript --local` and format
it with `deno fmt` after schema changes.

### Modules

- `src/app.ts`, `src/main.ts`: native HTTP server and API boundaries.
- `src/db.ts`: Supabase Auth verification and owner-scoped REST access.
- `src/chat.ts`: one bounded model request with three focused internal roles.
- `src/planner/`: urgency and priority ordering, location grouping, task lists,
  details and reference resolution.
- `src/validation.ts`: allowlisted inputs and Croner schedule validation.
- `src/scheduler.ts`: bounded polling and transactional reminder delivery;
  `src/deploy.ts` registers the Deno Deploy cron trigger.
- `public/`: dependency-free login/chat UI.
- `supabase/migrations/`: schema, RLS, and confirmation/delivery RPCs.

No agent framework, autonomous loops, frontend build step, or required extra
services. The per-account in-flight request guard is in-memory and only applies
within one server instance; it does not coordinate requests across Deno Deploy
instances. Use edge rate limiting for public routes and rely on the database's
transactional confirmation/delivery operations for cross-instance safety.
Requests use one model call, at most 1,800 output tokens, a 30-second AI
timeout, and one active mutation/chat request per account per process. Context
contains every open task (at most 300) as compact rows, up to 100 reminders, and
12 recent messages; full descriptions and finished tasks are excluded. Lists
show at most 300 tasks. This is a small family planner, not an unbounded
archive. Add external rate limits and provider spending limits as appropriate.
Logs intentionally omit credentials, provider responses, and chat content.

MIT licensed; see `LICENSE`.
