# Personal Planner

A small, chat-first personal/family planner. One Deno server, Supabase
Auth/Postgres, one OpenRouter model, and scheduled reminders. The only interface
is login and chat—including inline confirmations. One account represents one
family's context; there is no cross-account household sharing.

## Setup

1. Install [Deno 2](https://deno.com/). Create your own
   [Supabase](https://supabase.com/) project and
   [OpenRouter](https://openrouter.ai/) API key.
2. Apply all SQL files in `supabase/migrations/` in filename order in your
   Supabase SQL editor (or use `supabase db push` if you already use the
   Supabase CLI). Existing installations should apply only migrations not yet
   applied. The migration creates profiles, assets, tasks, messages, reminders,
   and planning sessions, with ownership policies on every table.
3. Enable email/password authentication in Supabase. Set its Site URL to your
   app's origin and configure your confirmation-email redirects. Users confirm
   their email, return to the app, and log in with their password. For public
   deployments, configure SMTP, auth rate limits, and appropriate signup
   restrictions.
4. Copy `.env.example` to `.env`, then fill in your deployment's credentials:
   - `SUPABASE_URL`: your project URL.
   - `SUPABASE_PUBLISHABLE_KEY`: public publishable key or legacy anon key.
     **Never put a secret/service-role key here.**
   - `OPENROUTER_API_KEY`: server-only API key.
   - `OPENROUTER_MODEL`: a model supporting JSON-object responses. The default
     is `openai/gpt-4.1-mini`; availability and pricing depend on your provider.
   - `SUPABASE_SERVICE_ROLE_KEY`: required server-only legacy service-role key.
     It is used only by the Deno server for trusted assistant messages and
     unattended reminders; never expose it to the browser.
   - `APP_ORIGIN`: exact browser origin, default `http://localhost:8000`. Set
     this to your HTTPS origin when deployed.
   - `PORT`: default `8000`.
5. From the repository root:

   ```sh
   deno task start
   ```

   Open <http://localhost:8000>, create an account, and log in. For development
   use `deno task dev`. Self-hosted deployments need a continuously running
   process for Croner reminders; termination stops Croner and gracefully shuts
   down HTTP. For Deno Deploy, follow the deployment instructions below.

Credentials belong to each self-hosting deployment, not individual app accounts.
The browser receives only the Supabase URL and public key. Auth tokens are held
in memory, not local storage; reloading requires login. `.env` is ignored by
Git.

## Checks

Run `deno task fmt`, `deno task lint`, or `deno task test` to check formatting,
lint rules, or tests individually. `deno task check` runs all three along with
type checks for both server entrypoints and the browser app. GitHub Actions runs
this full check on pushes and pull requests.

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

- “Set my timezone to Europe/Stockholm, currency to SEK, and budget to 400 SEK.”
  Set currency **before** adding assets/tasks; existing money is never
  converted.
- “Add our bicycles as an asset worth 600 SEK, with a note that they need
  servicing.”
- “Add returning library books near Central Library. Priority 4, 20 minutes,
  free.”
- “Add groceries near home. Priority 5, 30 minutes, estimated cost 250 SEK.”
- “What should the family do today? We have two hours and 400 SEK, starting at
  home.”
- “Show our tasks.” / “Mark the library task done.” / “Delete the bicycle
  asset.”
- “Remind me every Sunday at 18:00 to plan our week, in Europe/Stockholm.”
- “Remember that I should buy milk.”
- “Buy a new router on my next trip to the shopping centre.”
- “I'm going to the grocery store. What's on my shopping list?”
- “I've bought milk and a router.” (One confirmation completes both matched
  tasks.)
- “Fill my day with tasks, including a visit to Copenhagen. I have 600 SEK and
  60 minutes for tasks; leave travel time aside.”

Review the exact structured proposal displayed in chat, then **Confirm** or
**Cancel**. Even additions require confirmation. Changing priorities, completing
tasks, deleting data, setting preferences, and creating/removing reminders all
use the same flow. One action is proposed per turn; a completion action can
contain up to 20 tasks and succeeds or fails as a whole. Ambiguous item names
require clarification rather than guessed completion. To alter a reminder,
remove it and create a new one. Profile, asset, and task updates preserve fields
not explicitly changed. Monetary proposals are bound to the currency at proposal
time. If it has changed, cancel the old proposal and request a new one.

## Planning and safety boundaries

- Asset values are informational, **not automatically liquid cash**. Budget is
  an explicit preference or a constraint stated for the current plan.
- Money is integer minor units: e.g. 400 SEK is `40000`. Use the account's
  currency and that currency's minor-unit convention; no exchange-rate
  conversion.
- Task priority is 1–5. Open tasks are ordered by priority with a fixed boost
  for overdue/today deadlines; completed/cancelled tasks are excluded from
  planning.
- Unknown cost/duration remains `null`, not zero. The code-calculated
  priority-first plan excludes unknowns and fits known costs/durations to the
  interpreted budget and time. Review the interpreted constraints printed with
  every calculated plan. Tasks needing cost or duration estimates appear
  separately alongside the calculated plan; they are not included in its totals.
- Task context is generic: `kind` distinguishes ordinary tasks from purchases,
  `category` is a free-form label, `destinations` are optional user-specified
  place labels, and `next_trip` records trip intent without a date or timer. AI
  interprets informal requests and typos; application code validates the result.
  Existing tasks default to ordinary tasks; ask to classify older purchase tasks
  before expecting them on a shopping list.
- Shopping/task-list queries use saved open records, not AI-generated inventory.
  Completed/cancelled tasks are excluded. Saved destination matches appear
  separately from items whose suitability for that place is not established. No
  store or stock lookup is performed, including for named malls.
- Location labels and optional coordinates support geographic grouping.
  Straight-line distances are approximate; **travel time is not included**.
  There is no geocoder, live routing, traffic, business discovery, or
  opening-hours service. Supply coordinates or area labels and allow extra
  travel time yourself. Model-returned coordinates are retained only when they
  match an explicit latitude,longitude pair in the current message (comma or
  semicolon separated), or a saved task/profile location with the same label and
  coordinates. Otherwise only the label is used, without proximity matching.
- Visit-aware day plans work for any destination, not a predefined set of cities
  or shops. AI can suggest saved open tasks that could be done during the visit
  (including portable tasks). Code combines these with saved location matches,
  then applies priority, budget, and time constraints. Unmatched AI suggestions
  are explicitly unverified, not claims of local availability. A user-supplied
  destination coordinate pair and radius (greater than zero, at most 1,000 km)
  also support approximate straight-line proximity. Coordinates are not inferred
  through geocoding. Visit/travel costs and duration require a saved task with
  estimates or separate allowance; this is not a route or appointment optimizer.
- Financial guidance is basic budgeting, not investment, tax, legal, or lending
  advice. The app cannot purchase anything or perform financial transactions.
- The model can suggest and explain, but cannot execute arbitrary tools or SQL.
  Application validators allow only known fields/actions. Authenticated users
  have read-only table access and can append only their own user messages.
  Confirmation/cancellation use owner-validated RPCs; trusted assistant messages
  are written server-side with the privileged key. Confirmation can only
  transition pending proposals. Database constraints and ownership policies
  provide another boundary.
- Before sending chat, users must accept a notice that chat and selected saved
  task, location, and financial data go through OpenRouter and its model
  provider. Treat AI replies as suggestions; do not include secrets in chat.

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
invokes AI or changes tasks or budgets unattended. The server-side privileged
key is required for assistant replies and reminder delivery; it is never sent to
the browser.

## Development and checks

```sh
deno task check
```

This runs formatting, linting, server/browser syntax/type checks, and Deno
tests. Tests use mocked HTTP providers—no credentials, network permissions, or
paid AI requests are needed. They exercise authorization, ownership scoping,
request limits, proposal validation, deterministic money/planning, and Croner
timezones. The database migration was additionally exercised against PostgreSQL
for RLS, transaction rollback, concurrent confirmations, and duplicate reminder
delivery.

For a live deployment, use two test accounts to verify separate
chat/assets/tasks, confirm and cancel proposals, and schedule a minute-level
reminder. On Deno Deploy, verify the cron job is registered and that overlapping
or retried invocations produce only one reminder message for an occurrence. Real
Supabase and OpenRouter integration requires your own credentials and should be
checked before exposing the deployment.

The conversational regressions mock structured model outputs: they verify the
request paths, validation, saved-record selection and confirmation boundaries,
not a live model's accuracy at understanding every phrase or typo. Database
ownership/input/atomicity tests are in `supabase/tests/task_context.sql`; run
that file with `psql -v ON_ERROR_STOP=1` against a disposable database after
applying the migrations. The tests roll back their fixtures.

### Modules

- `src/app.ts`, `src/main.ts`: native HTTP server and API boundaries.
- `src/db.ts`: Supabase Auth verification and owner-scoped REST access.
- `src/chat.ts`: one bounded model request with three focused internal roles.
- `src/planner/`: task tracking, geographic context, deterministic budget
  planning.
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
summarizes at most 100 recent records per table and includes 12 recent messages.
Owner-scoped pagination fetches all saved assets, tasks, and reminders so an
older record can still be managed by its full description or ID; relevant full
details and bounded summaries keep model context below 120,000 characters.
Summaries truncate long text, and record-list replies are limited to 100 items.
This is a small family planner, not an unbounded archive. Add external rate
limits and provider spending limits as appropriate. Logs intentionally omit
credentials, provider responses, and chat content.

MIT licensed; see `LICENSE`.
