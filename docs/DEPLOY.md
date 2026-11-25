# Deploying Adminwise to Railway (EU)

The app is two Docker images (web and worker) and one Postgres database. Nothing in the code knows about Railway. The files `deploy/railway.web.json` and `deploy/railway.worker.json` record the intended service settings, but Railway no longer reads them for new services (Config-as-code is deprecated), so the settings are entered in the Railway screens as described below. The same images run on any Linux server (last section).

Target: `https://app.getadminwise.com`. The bare domain `getadminwise.com` stays free for the website.

## Before you start

- [ ] Both images build locally: `docker compose --profile full up --build` (proves the Dockerfiles before Railway tries them).
- [ ] The code is pushed to the private GitHub repository `ramongetadminwise/adminwise`.
- [ ] `.env` is complete locally and `pnpm check:ai` says ok for both models.
- [ ] Railway project "adminwise" exists with Postgres in EU West (Amsterdam).

## Step 1. Production secrets

Generate two values that exist only in production and store them in the password manager:

- `TOKEN_ENCRYPTION_KEY`: a new key (command in `.env.example`). Do not reuse the local one. Without this key the stored mailbox tokens cannot be read, so a lost key means every customer reconnects.
- `POSTMARK_INBOUND_SECRET`: 40 letters and digits.

## Step 2. Shared variables

In the Railway project: **Settings > Shared Variables** (environment "production"). Add every variable below once; both services will reference them.

| Variable | Value |
| --- | --- |
| `APP_NAME` | `Adminwise` |
| `APP_BASE_URL` | `https://app.getadminwise.com` |
| `INBOUND_DOMAIN` | `in.getadminwise.com` |
| `MAIL_FROM` | `Adminwise <hello@getadminwise.com>` |
| `TOKEN_ENCRYPTION_KEY` | the production key from step 1 |
| `AWS_REGION` | `eu-central-1` |
| `BEDROCK_MODEL_DRAFT` | `eu.anthropic.claude-sonnet-4-6` |
| `BEDROCK_MODEL_CLASSIFY` | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `AWS_ACCESS_KEY_ID` | from the password manager |
| `AWS_SECRET_ACCESS_KEY` | from the password manager |
| `MS_CLIENT_ID` | from the Entra app |
| `MS_CLIENT_SECRET` | from the password manager |
| `MS_TENANT` | `common` |
| `POSTMARK_SERVER_TOKEN` | from the password manager |
| `POSTMARK_INBOUND_SECRET` | from step 1 |
| `WORKER_CONCURRENCY` | `5` |
| `SELLER_COUNTRY` | optional; two-letter code of the EU country our own invoices are issued from, default `PL` (phase 4) |
| `ALERT_EMAIL` | the operator's address for failure summaries, e.g. `ramon.haagen@getadminwise.com` (phase 2) |

`DATABASE_URL` is not a shared variable; each service gets it as a reference to the database (next steps).

## Step 3. Web service

1. In the project: **+ New > GitHub Repo**. Authorise Railway for the `adminwise` repository if asked, pick it.
2. Open the new service > **Settings**: rename it to `web`; check **Region** is EU West (Amsterdam).
3. **Settings > Build**: builder **Dockerfile**, Dockerfile path `Dockerfile.web`. **Settings > Deploy**: healthcheck path `/api/health`, healthcheck timeout `120`, restart policy **On failure**, max retries `5`. (Railway deprecated Config-as-code: new services cannot opt in since 2026-08-28, so these are set by hand. If the builder cannot be chosen, add the service variable `RAILWAY_DOCKERFILE_PATH=Dockerfile.web`.)
4. **Variables**: **Shared Variable > Add all**; then add `DATABASE_URL` with the value `${{Postgres.DATABASE_URL}}`.
5. **Deploy**. The container applies the database migrations, then starts the web app on Railway's `PORT`. The deployment turns green when `/api/health` answers.

## Step 4. Domain

1. `web` service > **Settings > Networking > Custom Domain** > enter `app.getadminwise.com`. If Railway asks for the port, use the one it detected (the app listens on `PORT`).
2. Railway shows the DNS records to create. Add them in Cloudflare > getadminwise.com > **DNS > Records**:

   | Type | Name | Content | Proxy status |
   | --- | --- | --- | --- |
   | CNAME | `app` | the target Railway shows, of the form `xxxxxxxx.up.railway.app` | **DNS only** (grey cloud) |
   | TXT | `_railway-verify.app` | the verification value Railway shows, if it shows one | n/a |

   Keep the proxy off (grey cloud): Railway then issues the TLS certificate itself. With the orange cloud on, certificate issuance fails unless Cloudflare's SSL mode is set to Full.
3. Wait until Railway shows the domain as verified with a certificate (usually a few minutes).
4. Open `https://app.getadminwise.com/api/health`: it answers `{"ok":true}`.

## Step 5. Worker service

1. **+ New > GitHub Repo**, the same repository again.
2. **Settings**: rename to `worker`; region EU West (Amsterdam); **Build**: builder **Dockerfile**, path `Dockerfile.worker`; **Deploy**: restart policy **On failure**, max retries `5`, no healthcheck. No domain.
3. **Variables**: **Shared Variable > Add all**; add `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`.
4. **Deploy**. The log shows `[worker] running (drafts: eu.anthropic.claude-sonnet-4-6, classification: eu.anthropic.claude-haiku-4-5-20251001-v1:0, region eu-central-1)`.

## Step 6. Point the outside services at production

1. **Microsoft Entra** > App registrations > Adminwise > **Authentication** > Web > **Add URI**: `https://app.getadminwise.com/api/microsoft/callback`. Keep the localhost URI for development. Save.
2. **Postmark** > the server > **Inbound** stream > **Settings**: inbound domain `in.getadminwise.com`; webhook URL `https://postmark:<POSTMARK_INBOUND_SECRET>@app.getadminwise.com/api/webhooks/postmark`. Save, then use **Check** to send a test: it must answer 200.

## Step 7. Check end to end

1. `https://app.getadminwise.com`: sign in with your email; the link arrives by mail from `hello@getadminwise.com`.
2. Settings: fill in company, languages, signature; build the voice profile from three sent emails.
3. **Connect Microsoft 365** with a test mailbox in your own tenant. Send that mailbox a mail from another account: a reply draft appears in its Drafts folder within seconds, at most 5 minutes.
4. Forward a mail to `<slug>@in.getadminwise.com` (the address on the Settings page): the draft comes back by email.
5. Next morning at 07:30 in the customer's time zone the daily brief arrives.
6. Railway > Postgres > **Backups**: switch on daily backups.

## Day-to-day

- **Deploys**: pushing to `main` redeploys both services. Migrations run automatically.
- **Logs**: each service's **Deployments > View logs**. Logs never contain email bodies.
- **Model switch**: change `BEDROCK_MODEL_DRAFT` in Shared Variables and redeploy both services.
- **Scaling**: raise `WORKER_CONCURRENCY`, or add a worker replica; jobs are shared safely through the queue.

## Moving to a plain Linux server later

On any server with Docker:

1. Copy the repository and a filled `.env` to the server.
2. Use a managed Postgres or the `postgres` service from `docker-compose.yml` (with a real password and a backup).
3. `docker compose --profile full up -d --build`.
4. Put a reverse proxy with TLS (Caddy or nginx) in front of port 3000 and point the domain at it.

The environment variables, webhook URLs and health check are identical.

## Public site on getadminwise.com (phase 4)

The website is served by the same web service as the app. To show it on the main domain:

1. Railway, web service, Settings, Networking: add the custom domain `getadminwise.com` (and `www.getadminwise.com` if wanted). Railway shows the DNS record to create.
2. Cloudflare, DNS: add that record (a CNAME on the root is allowed in Cloudflare; keep it "DNS only", like the `app` record).
3. Leave `APP_BASE_URL` as `https://app.getadminwise.com`: sign-in links and the "Start free" buttons keep pointing at the app address.

Do this only when billing and the legal pages are ready (see docs/TO_VERIFY.md). Until then the site is visible at `https://app.getadminwise.com/` for anyone who is not signed in.

## Payments with Stripe (phase 4)

Variables (web service; the worker needs only `BILLING_ENABLED`):

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` from the sandbox for testing; `sk_live_...` for real payments |
| `STRIPE_WEBHOOK_SECRET` | the signing secret (`whsec_...`) of the webhook endpoint below |
| `STRIPE_AUTOMATIC_TAX` | `true` once Stripe Tax is set up in the Stripe account |
| `BILLING_ENABLED` | `true` on BOTH services to switch on trials, plan limits and read-only. Leave unset until payments are ready |

One-time, per Stripe account (sandbox and live each):

1. Locally, with that account's key in `.env`: `pnpm stripe:setup`. It creates the two plans, four prices and the portal settings.
2. In Stripe, Developers, Webhooks: add an endpoint `https://app.getadminwise.com/api/webhooks/stripe` for the events `checkout.session.completed` and all `customer.subscription.*` events. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.

3. In Stripe, Settings, Payment methods: leave only cards switched on (decision of 2026-11-23; the app cannot restrict this itself).

Test in the sandbox: sign in with an address that has no account yet, open Settings, choose a plan, pay with Stripe's test card 4242 4242 4242 4242 (any future date, any CVC). You should come back to Settings with "Your plan is active". Then open "Manage subscription", switch plan and cancel, and check Settings follows.

## Deploying the review fixes (24 Nov 2026)

1. Before deploying, look once at who is in the production `customers` table: every account that exists at that moment becomes "internal" (free, everything on) by migration 009.
2. Both services must have `APP_BASE_URL` and `POSTMARK_SERVER_TOKEN` set: in production the app now refuses to start without them. (`ALLOW_INCOMPLETE_CONFIG=true` switches this check off; do not use it in production.)
3. `BEDROCK_MODEL_DRAFT` and `BEDROCK_MODEL_CLASSIFY`, if set, must start with `eu.`, and `AWS_REGION` with `eu-`. Anything else stops the start.
4. Migration 011 runs by itself at start. It is small and safe while the old version still serves.
5. After the deploy: forward one mail with an invoice PDF to the forwarding address and check that the invoice is tracked (the new sender check).
6. Replacing the Microsoft client secret, now safe to do: create the new secret in Entra, set `MS_CLIENT_SECRET` on both services, wait for the redeploy, then delete the old secret. Never delete first. Note the new secret's expiry date in the calendar.

## The alarm from outside

`https://app.getadminwise.com/api/status` answers `200` with `{"ok":true,...}` when everything works, and `503` when the database is down, the worker has not shown a sign of life for 5 minutes, or a job has been waiting more than 20 minutes. Something outside our own systems must call it, or nobody hears the alarm.

1. Open an account at an uptime monitoring service (any that can call a web address every few minutes and warn by email or text; several have a free plan that is enough). Use a private email address for the account and for the warnings, not one that depends on Adminwise.
2. Add one monitor: type HTTP(S), address `https://app.getadminwise.com/api/status`, every 5 minutes, "up" means status 200. If the service can also look for a text, let it look for `"ok":true`.
3. Warn after 2 failed checks in a row, not after one: a deployment restarts the worker and may take a minute or two.
4. Add a second monitor on `https://getadminwise.com` (the public site), same settings. This address only works once the custom domain is added in Railway and its two DNS records exist (done on 25 Nov 2026).
5. Test it once: in Railway, stop the `worker` service for ten minutes. The warning must arrive. Start the worker again and the monitor must turn green by itself.

What each answer means when the warning comes:
- `"worker":"silent"`: the worker has stopped or cannot start. Look at the worker's deploy log in Railway.
- `"queue":"behind"`: the worker runs but work is waiting too long: a burst of mail, or the AI provider refusing requests. Look at the hourly alert mail and the worker log.
- `"database":"down"`, or no answer at all: the database or the web app is down. Look at Railway's status.
