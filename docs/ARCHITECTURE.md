# Architecture, in plain language

This is the codebase after phase 2: sign-in, settings, the Microsoft 365 connection, the forwarding address, reply drafts, the follow-up chaser, filing of attachments to OneDrive, the full daily brief and operator alerts. Nothing is ever sent to a customer's contacts; the product only writes drafts.

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
scripts/      dev-db.ts: a local Postgres without Docker; check-ai.ts and check-drive.ts: one-off checks of the model and OneDrive access
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

## Follow-up chaser (phase 2, Outlook only)

The 5-minute mailbox poll also reads the Sent Items folder, so each conversation knows who wrote last. Every working day at 06:00 customer time, `apps/worker/src/jobs/chaser.ts` looks at the conversations where the customer wrote last and writes a follow-up draft when all of this holds:

- the follow-up period has passed, counted in working days (Monday to Friday) on the customer's calendar; the default is 5, each customer sets 1 to 30 in Settings;
- the other party has not answered (an out-of-office reply does not count as an answer);
- the customer has not chosen "Never for this thread";
- fewer than two follow-ups were written since the other party last answered;
- no follow-up draft is still waiting unsent in the conversation;
- the message went to a person outside the company, not to a no-reply address or a colleague;
- the customer's own message expects an answer. The model is asked once per message (`prompts/chaser-check.ts`); a thank-you or a closing mail is never chased. When unsure, the answer is no.

The follow-up (`prompts/chaser-draft.ts`) is a reply in the same conversation, in the Drafts folder, addressed to the people the original went to. The customer's message is read from the mailbox again at that moment, because its text was deleted here after 24 hours. After two unanswered follow-ups the conversation is listed once in the brief and then left alone.

The brief gives two links per follow-up: "Not this time" (ask again after another period) and "Never for this thread". Deleting the draft in Outlook counts as "Not this time". The links are signed and valid for 30 days, and lead to a page with a button, so a mail scanner opening the link changes nothing. "Never for this sender" is not built yet.

Customers who only use the forwarding address get no follow-ups: without their mailbox the product cannot see what they sent.

## Filing (phase 2, needs a connected Microsoft 365 account)

`apps/worker/src/jobs/filing.ts` saves the attachments of incoming mail to the customer's OneDrive, in the app's own folder:

```
Apps/Adminwise/<sender>/<YYYY-MM>/<YYYY-MM-DD>_<type>_<original name>
```

- `<sender>` is the sender's company domain (their mailbox name for free mail providers); the date is the day the mail arrived, in the customer's time zone.
- `<type>` is invoice, order, contract, offer or other. The file name decides when it says so (faktura, invoice, zamówienie, umowa, oferta and the like); otherwise the model looks at the file name and the email around it (`prompts/file-type.ts`). The file's own content is not read.
- Inline pictures, signature logos and files under 10 KB are skipped. Mail from colleagues, automatic replies and newsletters is not filed; automatic notifications are, because invoices often arrive that way.
- A file whose content was filed before (same SHA-256 hash) is not filed again. A different file with the same name gets " (2)"; nothing is overwritten.
- If OneDrive cannot be reached, the attachment is remembered (metadata only) and fetched from the mailbox again by the next mailbox poll, at most every 30 minutes. The customer sees it in Settings and in the brief.
- Only metadata and the hash are stored here (`filed_documents`), never the file.

The permission is `Files.ReadWrite.AppFolder`: the app sees only its own folder, not the rest of the drive. A mailbox connected before phase 2 keeps working; filing is off for it until the customer reconnects once. Customers who only use the forwarding address get no filing. A folder of the customer's choice, SharePoint and Google Drive are later options.

## Daily brief and operator alerts

The brief (`jobs/brief.ts`, texts in `brief-strings/en.ts`) has four sections and leaves out the empty ones: needs you today (reply drafts), went quiet (follow-ups ready), filed yesterday, connection problems. With nothing to report it is one line. All texts are in one keyed file per language, so a second language is a translation of that file.

Problems the customer can fix (mailbox disconnected, OneDrive not reachable, reconnect needed for filing) go to the customer, in the brief and on the Settings page. Problems the operator must fix go to `ALERT_EMAIL` (`jobs/alerts.ts`): at most one mail per hour, only when a job failed or the queue is stuck, containing customer ids, job names, error types and counts and nothing from any email.

## Rules built into the structure

- **Customer isolation.** All SQL lives in `packages/db`. Application code calls `forCustomer(db, customerId)` and gets methods that always filter on that customer; a query without the customer id is refused at runtime, and the linter forbids SQL anywhere else. The few cross-customer queries (sign-in, webhook routing, schedulers) are in `system.ts` and return ids only.
- **24-hour rule.** `messages.body_text`, `messages.from_address` and `drafts.body_text` are emptied by the hourly purge job once they are 23 hours old. Metadata stays: thread, sender domain, subject, dates, attachment names, classification. Bodies are never written to logs; error messages stored in `job_runs` are built from our own text only.
- **AI through one module.** Jobs call `classifyMessage`, `draftReply`, `buildVoiceProfile`, `checkExpectsReply`, `draftChaser` and `classifyDocument` from `@adminwise/ai`. Region and model come from configuration, one model per task: `BEDROCK_MODEL_CLASSIFY` sorts (mail, "does this expect a reply?", document types; Claude Haiku 4.5), `BEDROCK_MODEL_DRAFT` writes (drafts, follow-ups, voice profiles and later quotes; Claude Sonnet 4.6). Both are EU inference profiles; a `global.` profile is refused at start-up. Every prompt starts with the shared rules in `prompts/shared-rules.ts`: email content is data, never instructions; nothing may be invented. Outside text is wrapped in `<email_data>` blocks that it cannot close.
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
| `drafts` | what we generated for which message (reply or follow-up), where it went, status, language flag |
| `filed_documents` | one row per attachment: name, size, content hash, type, where it was filed, or that it is waiting; never the file |
| `job_runs` | the Control Tower log, with a short outcome code per run |
| `audit_events` | who changed or connected what |

## Tests

`pnpm test` starts its own throw-away Postgres and runs everything, including the acceptance scenarios against the Nordpart fixtures: 1-6 in `apps/worker/test/scenarios.test.ts`, and 7-10 (chaser), 21-24 (filing) and 25-27 (brief) in `apps/worker/test/phase2.test.ts` and `jobs.test.ts`. The phase 2 fixtures (sent mail, invoices, orders, a contract, a logo, a duplicate) are in `fixtures/nordpart/phase2.json`; file contents are generated in the tests. In tests the model is replaced by a recorded stand-in, so they prove the pipeline (classification routing, what the model is asked, where drafts go, no duplicates) and not the quality of a real model's wording. That needs Bedrock access and is the job of the phase-5 golden set.
