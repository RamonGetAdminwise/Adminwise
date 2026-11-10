# Adminwise - code repository

A hosted back-office service for small companies. Phase 1: sign-in, settings, voice profile, Microsoft 365 connection, forwarding-address intake, reply drafts, a first daily brief. Drafts only; nothing is sent to a customer's contacts.

- What the folders are and how a mail flows through: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Accounts, model ids and the AWS key: [docs/ACCOUNTS_SETUP.md](docs/ACCOUNTS_SETUP.md)
- Microsoft app registration: [docs/MICROSOFT_SETUP.md](docs/MICROSOFT_SETUP.md)
- Deployment: [docs/DEPLOY.md](docs/DEPLOY.md)
- Spec and decisions: `../01_Project_docs/`

## Run locally

Needs Node 24 or newer and pnpm. Open a terminal in this folder (`03_Build`).

**1. Install**

```bash
pnpm install
```

**2. Settings file.** Copy `.env.example` to `.env` and fill in at least `TOKEN_ENCRYPTION_KEY` (the file explains how to generate one). Everything else can stay empty to start: without Postmark, mail is printed in the console; without Microsoft and AWS keys, those features report that they are not set up.

**3. Database.** Either one works; keep it running in its own terminal.

```bash
pnpm dev:db
```

That starts a Postgres without Docker (data in your user folder, outside OneDrive) on port 5432 and prints the `DATABASE_URL`. Or, with Docker Desktop running:

```bash
docker compose up -d
```

**4. Create the tables**

```bash
pnpm db:migrate
```

**5. Start the web app** (terminal 2), then open http://localhost:3000

```bash
pnpm dev:web
```

**6. Start the worker** (terminal 3)

```bash
pnpm dev:worker
```

**7. Sign in.** Enter your email on the start page. Without Postmark the sign-in link appears in the web app's terminal; open it and press "Sign in".

What works at which point:

| You have | You can |
| --- | --- |
| nothing but `.env` with the encryption key | sign in, edit settings, see your forwarding address, run all tests |
| + AWS keys (`pnpm check:ai` confirms them) | build a voice profile; business mail gets real drafts |
| + Microsoft app registration | connect an Outlook mailbox; drafts appear in its Drafts folder (polling every 5 minutes on localhost) |
| + Postmark and a domain | real sign-in emails, the forwarding address, the daily brief by email |

## Tests

```bash
pnpm test
```

Starts its own throw-away Postgres (no Docker, nothing to set up) and runs all tests, including acceptance scenarios 1-6 against the Nordpart fixtures in `fixtures/nordpart`. To use an existing database instead, set `TEST_DATABASE_URL`.

Other checks, all run by GitHub Actions on every push:

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm build:web
```

## House rules for this code

- New codebase: nothing copied from other projects; fixtures are invented and use `.example` domains.
- SQL only in `packages/db`; everything else uses `forCustomer(db, customerId)` or `system(db)`.
- Model calls only through `packages/ai`; one prompt file per job in `packages/ai/prompts`.
- Email bodies never go to logs and are emptied within 24 hours.
- Secrets only from environment variables; `.env` is never committed.
