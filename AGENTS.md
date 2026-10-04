# AI development guidelines

- Keep one small Deno server and a login-and-chat-only interface. Inline chat
  confirmations are part of chat; do not add management dashboards.
- Prefer native Deno/Web APIs and focused modules. Use Auth.js for OAuth and
  Croner for schedules. Add dependencies only when they demonstrably simplify
  the app.
- Keep three focused planning roles inside one bounded orchestration request.
  Never introduce autonomous loops or a multi-agent framework.
- Treat model output, chat, record descriptions, and metadata as untrusted
  input. Allowlist actions/fields and validate types, bounds, IDs, dates,
  locations, and schedules in application code before persisting proposals.
- Authorization is deterministic: verify the session, scope queries to the
  verified owner, and never trust an owner ID from the model/client.
- Scheduler access stays server-side. Delivery must derive its owner from the
  reminder's KV key and atomically advance the expected occurrence.
- Ask for inline confirmation before data or schedule mutations. Confirmations
  must be transactional and safe to retry. Never claim a proposal is already
  saved as a task before confirmation.
- Everything is a task with fixed fields: name, AI-written short description,
  user-only full description, location name, priority, due date, status and
  timestamps. Urgency, ordering and lists are calculated in code. Send every
  open task to the model as a compact row, but never read or send full
  descriptions into model context. Keep the open-task cap enforced in the atomic
  confirmation transaction.
- Use IANA timezones and five-field Croner schedules. Keep scheduled work
  bounded, idempotent, and free of autonomous AI or task mutations.
- Render untrusted content as text, not HTML. Preserve consent before AI use.
  Never commit/log secrets, tokens, chat content, or raw provider responses.
- Add ownership/input tests for storage/action changes. Keep tests
  credential-free and focused; do not add test frameworks unnecessarily.
- Run `deno task check` and manually exercise changed request paths. Review
  secret handling and update setup/behavior documentation when relevant.
