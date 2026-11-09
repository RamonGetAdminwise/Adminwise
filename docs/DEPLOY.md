# Deploying to Railway (EU)

The app is two Docker images (web and worker) and one Postgres database. Nothing in the code knows about Railway; the only Railway files are `deploy/railway.web.json` and `deploy/railway.worker.json`. The same images run on any Linux server (last section).

Status: the Dockerfiles have not been built on this machine yet (Docker Desktop was installed but needs a restart and WSL before it runs). Build them locally once (`docker compose --profile full up --build`) before the first deployment.

## Before you start

- The code is in a private GitHub repository.
- You have the values for the environment variables (`.env.example` lists them; `ACCOUNTS_SETUP.md` explains where they come from).
- You know the public domain of the app, for example `app.<your domain>`.

## 1. Project and database

1. https://railway.com > **New Project > Deploy PostgreSQL**.
2. Open **Project Settings** and check the region; choose **EU West (Amsterdam)** for every service, including Postgres.

## 2. Web service

1. **New > GitHub Repo**, pick the repository. Name the service `web`.
2. **Settings > Config-as-code**: path `deploy/railway.web.json` (it selects `Dockerfile.web` and the health check `/api/health`).
3. **Settings > Networking > Generate Domain**, or add your custom domain and create the CNAME record Railway shows.
4. **Variables**: add everything from `.env.example`, with these production values:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Railway's reference to the database)
   - `APP_BASE_URL` = `https://app.<your domain>` (no trailing slash)
   - `TOKEN_ENCRYPTION_KEY` = a new key, generated as described in `.env.example`. Store a copy in your password manager: without it, stored mailbox tokens cannot be read.
5. Deploy. The container runs database migrations, then starts the web app on Railway's `PORT`.

## 3. Worker service

1. **New > GitHub Repo**, same repository. Name the service `worker`.
2. **Settings > Config-as-code**: path `deploy/railway.worker.json`.
3. No public domain.
4. **Variables**: the same set as web. The simplest way to keep them identical: define them once as **Shared Variables** in the project and reference them from both services.
5. Deploy. The log should show `[worker] running (model ... in eu-central-1)`.

## 4. Point the outside services at the deployment

- **Microsoft**: add `https://app.<your domain>/api/microsoft/callback` as a redirect URI (`MICROSOFT_SETUP.md`, step 2).
- **Postmark**: set the inbound webhook URL to `https://postmark:<POSTMARK_INBOUND_SECRET>@app.<your domain>/api/webhooks/postmark` (`ACCOUNTS_SETUP.md`, part 3).

## 5. Check

1. Open `https://app.<your domain>/api/health`: it answers `{"ok":true}`.
2. Sign in with your email; the link arrives by mail.
3. Connect a test Microsoft 365 mailbox; send it a mail; a draft appears in Drafts within seconds (notification) or at most 5 minutes (poll).
4. Forward a mail to `<slug>@in.<your domain>`; the draft comes back by email.
5. Next morning at 07:30 in the customer's time zone the daily brief arrives.

## Day-to-day

- **Deploys**: pushing to `main` redeploys both services. Migrations run automatically.
- **Logs**: each service's **Deployments > View logs**. Logs never contain email bodies.
- **Backups**: enable Railway's Postgres backups in the database service (daily). A fuller backup routine is a phase-2+ item.
- **Scaling**: raise `WORKER_CONCURRENCY`, or run a second worker replica; jobs are shared safely through the queue.

## Moving to a plain Linux server later

On any server with Docker:

1. Copy the repository and a filled `.env` to the server.
2. Use a managed Postgres or the `postgres` service from `docker-compose.yml` (with a real password and a backup).
3. `docker compose --profile full up -d --build`.
4. Put a reverse proxy with TLS (Caddy or nginx) in front of port 3000 and point the domain at it.

The environment variables, webhook URLs and health check are identical.
