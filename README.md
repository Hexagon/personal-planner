# Dayfold

**A personal to-do list you can talk to. Less to keep in your head.**

Organize tasks and errands through a simple conversation. See what needs
attention, and confirm changes before they are saved. No complicated forms,
productivity streaks, or unattended task changes.

- **Less mental clutter.** Keep tasks and errands together.
- **Simple organization.** Add dates, priorities, and places in plain language.
- **A clearer next step.** See what is due and coming up.
- **You stay in control.** Review changes before saving them.

### A small example

This is an illustration, not a live conversation:

1. **You:** “Add buy milk at the grocery store.”
2. **Dayfold:** proposes a task named “Buy milk,” located at “Grocery store.”
   **Not saved yet.**
3. **You:** choose **Confirm** (or **Cancel** to leave your list unchanged).
4. **Dayfold:** shows the confirmed change as saved.

Dayfold is a personal list, not a shared household account or a calendar. Each
OAuth provider identity is a separate account. Use the same provider each time;
accounts cannot be linked or shared. Reminders appear in chat, not as email or
push notifications.

## Using chat

Sign in, then review **Settings**, which opens automatically if AI consent or
chat access is missing. Accept the explicit data notice, add a key if needed,
and choose **Save** to apply consent, model/reasoning, key and timezone settings
together. You can close Settings and still read saved history and upcoming items
without a model request. To revoke consent, uncheck the notice and choose
**Save**. Chat access is disclosed before sign-in: a deployment can provide a
server-side key, or require your personal OpenRouter key. Usage is billed to the
account whose key is used; app-provided access is not a promise of unlimited or
free usage.

Model, reasoning, and personal-key options stay in Settings. Your key stays in
account-scoped tab storage unless you explicitly choose device persistence.
Blocked storage falls back to page memory and reports that it was not saved.

For a new conversation, start with a real task. Suggestions only fill your
draft; they never send automatically. Settings detects your browser's IANA
timezone during initial setup (falling back to UTC if detection is unavailable).
Review or edit it and choose **Save** to store it in your account without an AI
request. Existing saved timezones are preserved. Change your account timezone
only in Settings, not chat. Existing reminders retain their own timezone and
schedule; task dates are grouped using the saved account timezone.

The message composer stays compact until you click its expand button. Sending a
message does not expand it.

Ask in plain language to create, update, complete, cancel, or delete tasks; set
preferences; or create reminders. Review each structured proposal and choose
**Confirm** or **Cancel**. Chat mutations are never applied before confirmation.
Ambiguous task or reminder references need clarification. Proposal cards are
available only with the reply that created them. If you skip one or lose it from
the current chat view, ask again rather than retrieving an older proposal.

Tasks have a name, AI-written short description, optional user-written full
description and location, priority (1–5), optional due date, status, and
timestamps. The app calculates urgency and ordering, and renders task lists from
saved records. Up to 300 open tasks are supported. Example requests:

- “Remember that I should buy milk at the grocery store.”
- “Add car service at the garage, priority 4, due Friday.”
- “What’s urgent?” or “What’s at the grocery store?”
- “Show my completed tasks,” “Show cancelled tasks,” or “Reopen [task name].”
- “Remind me every Sunday at 18:00 to plan our week, in Europe/Stockholm.”
- “Pause my Sunday planning reminder,” “Resume it,” or “Change it to Mondays.”

Reminders use five-field cron schedules and IANA timezones. They appear in chat,
not as email or push notifications. They are checked once per minute, so
delivery can be delayed by hosting availability. Scheduled work only posts the
reminder; it does not invoke AI or change tasks unattended. If the server is
unavailable, at most one catch-up message is posted for each overdue reminder
when service resumes; older missed occurrences are skipped. Pause, resume,
reschedule, edit, and delete reminders in chat, and confirm each proposed
change.

The **alarm icon** beside Settings opens all saved active reminders (their next
occurrence) and open tasks with due dates, grouped into Overdue, Today,
Tomorrow, and Later. Task dates and groups use your saved timezone (UTC until
set); reminder times show their own saved timezone. Completed/cancelled tasks,
undated tasks, paused reminders, and unconfirmed proposals are not shown. Ask in
chat for open, completed, or cancelled tasks; reopening a task is a proposed
change and needs confirmation.

A compact **On your radar** pane stays above chat when tasks are overdue or due
today, or reminders are awaiting delivery or coming within 24 hours. It shows up
to three items, earliest first, with task priority breaking same-date ties. Hide
it for the current signed-in page session with **✕**; the alarm icon remains
available. With nothing near-term, the pane stays hidden. Items refresh with
chat every 30 seconds while the page is visible, after confirmations, and when
opening the alarm menu; **Refresh** retries loading failures. This read-only
view needs no AI consent or provider request. Use chat and inline confirmation
for changes.

## Privacy and limits

- The server scopes saved data to the verified signed-in account. Model and
  client-supplied owner IDs are not trusted.
- Before each chat request, open tasks are sent as compact rows. Full task
  descriptions are never read into AI context; “Show details of …” reads them
  directly from storage. Recent chat text is still part of AI context.
- With consent, chat, preferences, reminder summaries, and compact open-task
  rows are sent through OpenRouter to its model provider. Historical proposals
  are not included in model context. Optional online search is off by default.
  Do not put secrets in chat.
- Personal OpenRouter keys are forwarded to OpenRouter but never saved by the
  server. They use account-scoped tab storage by default; remembering a key on
  the device is an explicit opt-in and is not recommended on shared devices.
- The app currently has no in-app data export or account-data deletion. Removing
  an OAuth identity does not remove planner data. Self-hosters manage the local
  `data/planner.sqlite3` database themselves; deployed data requires action by
  the deployment operator.
- Locations are plain labels: the planner does not provide routes, store
  details, opening hours, or inventory. It cannot purchase anything or track
  money, budgets, costs, or durations.

## Self-hosting quick start

Dayfold runs as one small Deno server with Deno KV, Auth.js OAuth,
OpenRouter-powered chat, and scheduled reminders using Croner or Deno Deploy
cron. The interface stays login and chat; there is no frontend build.

1. Install [Deno 2](https://deno.com/) and create a Google OAuth client, GitHub
   OAuth app, or both. Set the callback URL to
   `<APP_ORIGIN>/auth/callback/google` and/or
   `<APP_ORIGIN>/auth/callback/github` (locally:
   `http://localhost:8000/auth/callback/<provider>`).
2. Copy `.env.example` to `.env` and set:
   - `AUTH_SECRET` to a random secret of at least 32 bytes.
   - At least one complete provider pair: `GOOGLE_CLIENT_ID` /
     `GOOGLE_CLIENT_SECRET` or `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.
   - `APP_ORIGIN` to the exact app origin (default: `http://localhost:8000`).
   - Optionally, `OPENROUTER_API_KEY` for a shared server-side key and
     `OPENROUTER_MODEL` (`deepseek/deepseek-v4-flash` or
     `deepseek/deepseek-v4-pro`). `PORT` defaults to `8000`.
   - Leave `APP_ENV=development` locally. Set `APP_ENV=production` only on the
     intended public HTTPS deployment to allow search indexing.
3. Run `deno task start`, open <http://localhost:8000>, and sign in. Users can
   enter their own OpenRouter key in **Settings** instead of using a shared key.

Use `deno task dev` while developing. Self-hosted reminders require the server
to keep running. The local Deno KV database remains at `data/planner.sqlite3`;
OAuth identities are separate and existing Supabase data is not imported.

## Deployment

For self-hosting, configure the environment above and run `deno task start`. For
Deno Deploy, provision and link a Deno KV database, use `src/deploy.ts` as the
entrypoint, and configure the same environment variables in the project. Deploy
registers a native cron job; self-hosted runs use Croner. Set the exact HTTPS
`APP_ORIGIN`, register matching OAuth callback URLs, and apply trusted edge rate
limits to `/api/chat` and `/api/confirm`. Set provider spending limits as
appropriate. No frontend build is needed; include `public/`.

GitHub Actions deploys only pushes to `dev` and `main`. Configure the
`DENO_DEPLOY_PROJECT` repository variable and `DENO_DEPLOY_TOKEN` secret. Set
`APP_ENV=production` in Deno Deploy's production environment; other or unset
values show a Preview badge on Deno Deploy.

### Public metadata and indexing

Canonical and social-image URLs are rendered server-side from `APP_ORIGIN`,
never the incoming Host header. The public landing copy and chat-access
requirement are readable without JavaScript. `/social.png` is a static,
synthetic brand card; no account or conversation content enters metadata.

Only an HTTPS deployment with `APP_ENV=production`, not marked Preview, allows
indexing of the query-free homepage. Other environments and query-bearing pages
send `noindex, nofollow`. `/robots.txt` disallows all crawling outside
production; production excludes `/auth/` and `/api/` and lists a one-page
`/sitemap.xml`. Authentication/API responses also send `noindex, nofollow`.
These directives are not authorization: existing session checks still protect
account data.

Keep the current origin for the initial rollout. A later domain change requires
coordinated `APP_ORIGIN`, OAuth callbacks, redirects, and indexing changes.
Browser-stored keys, consent, and preferences do not transfer automatically to a
different origin. Do not copy credentials or consent between accounts.

## Development

Run the full formatting, lint, type-check, and test suite with:

```sh
deno task check
```

Tests use in-memory Deno KV and a mocked AI provider; they need no credentials,
network access, or paid AI requests. OAuth and live OpenRouter integration need
manual testing with your own credentials.

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch and pull request guidance. The
project is MIT licensed; see `LICENSE`.
