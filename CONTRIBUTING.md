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
provider requests are needed.
