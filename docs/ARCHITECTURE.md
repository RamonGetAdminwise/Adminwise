# Architecture, in plain language

This is the phase-1 codebase: sign-in, settings, the Microsoft 365 connection, the forwarding address, reply drafts and a first daily brief. Nothing is ever sent to a customer's contacts; the product only writes drafts.

## The two programs

| Program | Folder | What it does |
| --- | --- | --- |
| Web app | `apps/web` | What a customer sees in the browser (sign-in, settings, connect mailbox) and the two addresses that outside services call: Microsoft ("a mail arrived") and Postmark ("here is a forwarded mail"). It never does slow work; it stores the mail and puts a job on the queue. |
| Worker | `apps/worker` | Runs the jobs: classify a mail, write the draft, poll mailboxes, delete old bodies, send the daily brief. You can run several workers; they share the queue. |

Both talk to one Postgres database. The queue and the schedules live in that same database (pg-boss), so there is no Redis and nothing else to host.

## Folders

```
apps/
  web/        Next.js app: pages under src/app, webhook routes under src/app/api
  worker/     job runner: one file per job under src/jobs, tests under test/
packages/
  db/         the database: migrations/*.sql and the only code allowed to write SQL
  core/       shared plumbing: configuration, queue names, time zones, mail intake, Outlook gateway
  mail/       provider adapters: Microsoft Graph (graph.ts) and Postmark (postmark.ts)
  ai/         the only door to the model: src/bedrock.ts, one prompt file per job in prompts/
fixtures/     invented test companies and emails (Nordpart)
docs/         this file, setup and deployment guides
deploy/       Railway configuration (the only Railway-specific files)
scripts/      dev-db.ts: a local Postgres without Docker
test/         starts the test database
```

## What happens when a mail arrives

1. **It reaches us** one of three ways: Microsoft Graph notifies `/api/webhooks/graph`; or the 5-minute poll finds it (the safety net if a notification was missed); or the customer forwarded it to `<slug>@in.<domain>` and Postmark posts it to `/api/webhooks/postmark`.
2. **Intake** (`packages/core/src/ingest.ts`) stores it in the `messages` table. The same mail arriving twice is recognised by its Message-ID and stored once; the second copy stops here.
3. **The reply-draft job** (`apps/worker/src/jobs/process-message.ts`) runs:
   - *Classify.* Rules first (`prefilter.ts`): automatic replies, mailing lists, system senders and colleagues are recognised from headers and addresses, at no AI cost. Only mail that may be from a real outside person goes to the model, which answers: business / newsletter / notification / auto-reply / internal, plus the sender's language.
   - *Draft.* For business mail only. The model gets the customer's voice profile, the language to write in, the latest message (with quoted history cut off) and up to 8 earlier messages as background. The signature from settings is appended by code, not by the model.
   - *Deliver.* Microsoft 365 customer: a reply draft in their Outlook Drafts folder, on the thread. Forwarding customer: the draft is emailed back to them with a one-line explanation.
   - *Log.* One row in `job_runs` (the Control Tower): customer, job, status, start, finish, tokens, error.

## Rules built into the structure

- **Customer isolation.** All SQL lives in `packages/db`. Application code calls `forCustomer(db, customerId)` and gets methods that always filter on that customer; a query without the customer id is refused at runtime, and the linter forbids SQL anywhere else. The few cross-customer queries (sign-in, webhook routing, schedulers) are in `system.ts` and return ids only.
- **24-hour rule.** `messages.body_text`, `messages.from_address` and `drafts.body_text` are emptied by the hourly purge job once they are 23 hours old. Metadata stays: thread, sender domain, subject, dates, attachment names, classification. Bodies are never written to logs; error messages stored in `job_runs` are built from our own text only.
- **AI through one module.** Jobs call `classifyMessage`, `draftReply`, `buildVoiceProfile` from `@adminwise/ai`. Region and model come from configuration, one model per task: `BEDROCK_MODEL_CLASSIFY` sorts mail (Claude Haiku 4.5), `BEDROCK_MODEL_DRAFT` writes drafts, voice profiles and later quotes (Claude Sonnet 4.6). Both are EU inference profiles; a `global.` profile is refused at start-up. Every prompt starts with the shared rules in `prompts/shared-rules.ts`: email content is data, never instructions; nothing may be invented. Outside text is wrapped in `<email_data>` blocks that it cannot close.
- **Drafts only.** There is no code path that sends mail to anyone but the customer's own users (sign-in link, draft emailed back, daily brief).
- **Tokens encrypted.** Microsoft access and refresh tokens are stored with AES-256-GCM; the key is `TOKEN_ENCRYPTION_KEY`.
- **Time zones.** Each customer has an IANA zone. A one-minute tick checks whose local clock has reached 07:30 and sends that customer's brief once per local day.

## Data model (first cut)

| Table | Holds |
| --- | --- |
| `customers` | company name, slug (forwarding address), languages, time zone, signature, voice profile |
| `users` | people who can sign in, each belonging to one customer |
| `login_tokens`, `sessions` | magic-link sign-in; only hashes are stored |
| `mailbox_connections` | provider (microsoft / forwarding), encrypted tokens, status, notification subscription, polling bookmark |
| `threads`, `messages` | metadata of each conversation and mail, plus the body field that the purge empties |
| `drafts` | what we generated for which message, where it went, status, language flag |
| `job_runs` | the Control Tower log |
| `audit_events` | who changed or connected what |

## Tests

`pnpm test` starts its own throw-away Postgres and runs everything, including acceptance scenarios 1-6 against the Nordpart fixtures (`apps/worker/test/scenarios.test.ts`). In tests the model is replaced by a recorded stand-in, so they prove the pipeline (classification routing, what the model is asked, where drafts go, no duplicates) and not the quality of a real model's wording. That needs Bedrock access and is the job of the phase-5 golden set.
