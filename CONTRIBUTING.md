# Contributing

## Branches and pull requests

Always base changes on the latest `dev` branch. Before starting work, fetch
`origin`, update your local `dev` branch from `origin/dev`, and create a
descriptive feature branch from it. Do not base work on `main` or another branch
unless the task explicitly requests it. Open pull requests against `dev`.

Keep changes focused and follow the project guidance in `AGENTS.md`. Do not
commit secrets, credentials, tokens, chat content, or raw provider responses.

## Checks

Run the full check suite before submitting a pull request:

```sh
deno task check
```

Tests use in-memory Deno KV and mocked AI responses, so no credentials or paid
provider requests are needed. Manually exercise any changed request paths; OAuth
and live OpenRouter integration require your own credentials.

## End-to-end journey checklist

- [ ] Sign in with a provider, accept the AI notice, and start chatting with
      both an app-provided key and a personal key; verify consent and key scope
      in Settings.
- [ ] Ask for a task list, an ambiguous task change, and a completed/cancelled
      task list; confirm a mutation, retry the same confirmation, and reopen a
      finished task.
- [ ] Create a reminder, edit its description or schedule, pause it, resume it,
      then delete it. Confirm each change and verify paused reminders do not
      appear in upcoming items or deliver.
- [ ] Load more than 100 conversation messages, page to older messages, then
      jump to the latest. Confirm older pending proposals still expose current
      Confirm/Cancel state.
- [ ] Switch signed-in accounts, revoke consent in another tab, and change
      timezone; verify chat history, browser credentials, date grouping, and
      reminder times stay scoped and correct.
- [ ] Exercise a provider failure, lost connection, expired session, and delayed
      reminder delivery; use refresh before retrying uncertain chat requests.
- [ ] Check keyboard-only and screen-reader navigation for chat, inline
      confirmations, history controls, Settings, and upcoming items; review the
      layout on a narrow mobile viewport.
