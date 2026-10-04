# Personal Planner

A small, chat-first family planner. It runs as one Deno server with Deno KV,
Auth.js OAuth, OpenRouter-powered chat, and scheduled reminders. The interface
is login and chat; proposals are reviewed and confirmed inline. Accounts are
separate—there is no household sharing between accounts.

## Quick start

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
3. Run `deno task start`, open <http://localhost:8000>, and sign in. Users can
   enter their own OpenRouter key in **Settings** instead of using a shared key.

Use `deno task dev` while developing. Self-hosted reminders require the server
to keep running. The local Deno KV database is created at
`data/planner.sqlite3`; OAuth identities are separate and existing Supabase data
is not imported.

## Using chat

Accept the AI data notice in **Settings** before sending a message. Ask in plain
language to create, update, complete, cancel, or delete tasks; set preferences;
or create reminders. Review each structured proposal and choose **Confirm** or
**Cancel**. Mutations are never applied before confirmation. Ambiguous task
references need clarification.

Tasks have a name, AI-written short description, optional user-written full
description and location, priority (1–5), optional due date, status, and
timestamps. The app calculates urgency and ordering, and renders task lists from
saved records. Up to 300 open tasks are supported. Example requests:

- “Set my timezone to Europe/Stockholm.”
- “Remember that I should buy milk at ICA.”
- “Add car service at the garage, priority 4, due Friday.”
- “What’s urgent?” or “What’s at ICA?”
- “Remind me every Sunday at 18:00 to plan our week, in Europe/Stockholm.”

Reminders use five-field cron schedules and IANA timezones. They appear in chat,
not as email or push notifications. Scheduled work only posts the reminder; it
does not invoke AI or change tasks unattended.

## Privacy and limits

- The server scopes saved data to the verified signed-in account. Model and
  client-supplied owner IDs are not trusted.
- Before each chat request, open tasks are sent as compact rows. Full task
  descriptions are never read into AI context; “Show details of …” reads them
  directly from storage. Recent chat text is still part of AI context.
- With consent, chat, preferences, reminder summaries, recent proposal states,
  and compact open-task rows are sent through OpenRouter to its model provider.
  Optional online search is off by default. Do not put secrets in chat.
- Personal OpenRouter keys are forwarded to OpenRouter but never saved by the
  server. They use account-scoped tab storage by default; remembering a key on
  the device is an explicit opt-in and is not recommended on shared devices.
- Locations are plain labels: the planner does not provide routes, store
  details, opening hours, or inventory. It cannot purchase anything or track
  money, budgets, costs, or durations.

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
