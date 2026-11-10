# Deploying Adminwise to Railway (EU)

The app is two Docker images (web and worker) and one Postgres database. Nothing in the code knows about Railway; the only Railway files are `deploy/railway.web.json` and `deploy/railway.worker.json`. The same images run on any Linux server (last section).

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

`DATABASE_URL` is not a shared variable; each service gets it as a reference to the database (next steps).

## Step 3. Web service

1. In the project: **+ New > GitHub Repo**. Authorise Railway for the `adminwise` repository if asked, pick it.
2. Open the new service > **Settings**: rename it to `web`; check **Region** is EU West (Amsterdam).
3. **Settings > Config-as-code**: path `deploy/railway.web.json` (selects `Dockerfile.web` and the health check `/api/health`).
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
2. **Settings**: rename to `worker`; region EU West (Amsterdam); **Config-as-code** path `deploy/railway.worker.json`. No domain.
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
