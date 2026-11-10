# Accounts: what exists and what each one still needs

Status on 2026-11-10. Secrets live in the password manager and in `.env` / Railway variables only; never in this repository, never in chat.

| Account | State | Still to do |
| --- | --- | --- |
| Cloudflare | DNS for getadminwise.com | CNAME for `app` (see `DEPLOY.md`), DMARC record |
| GitHub | user `ramongetadminwise`, private repo `adminwise` | first push |
| AWS | account "Adminwise", eu-central-1, 50 USD budget alert, Anthropic use-case form accepted | IAM user and access key (part 1 below) |
| Microsoft Entra | app "Adminwise", multitenant (organisations), 4 delegated permissions, localhost redirect URI, client secret | production redirect URI once the app is live |
| Postmark | Live server, DKIM + Return-Path verified, MX for `in.getadminwise.com` in place | inbound webhook URL once the app is live |
| Railway | project "adminwise", Postgres in EU West (Amsterdam) | web and worker services (`DEPLOY.md`) |

Portals rename their menus from time to time; if a label differs slightly, the step is the same.

## 1. AWS: the key the app uses to call Claude

### Models

| Task | Model | Bedrock id (EU inference profile) | Variable |
| --- | --- | --- | --- |
| Drafts, voice profile, later quotes | Claude Sonnet 4.6 | `eu.anthropic.claude-sonnet-4-6` | `BEDROCK_MODEL_DRAFT` |
| Classification | Claude Haiku 4.5 | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | `BEDROCK_MODEL_CLASSIFY` |

- The `eu.` prefix is the EU cross-region inference profile: the request goes to Frankfurt and Bedrock may serve it from another EU region in the profile, never outside the EU. The base ids without a prefix (`anthropic.claude-sonnet-4-6`, `anthropic.claude-haiku-4-5-20251001-v1:0`) cannot be invoked on demand; Bedrock answers with an error that asks for an inference profile.
- Never use the `global.` ids: they can process a request anywhere in the world. The app refuses to start if a model variable begins with `global.`.
- The EU profiles cost about 10 % more than the global ones. That is the price of the EU promise.
- Claude Sonnet 5: AWS refuses it on the new account for now (support case opened 2026-11-10). When it is enabled, look up its EU profile id in **Bedrock > Model catalog > Claude Sonnet 5** (expected: `eu.anthropic.claude-sonnet-5`) and change the one line `BEDROCK_MODEL_DRAFT`. Compare draft quality on the fixtures before switching production.

### Create the IAM user (about 5 minutes)

The app must not use your own login. It gets a user that can do one thing: call Claude models.

1. AWS console > search **IAM** > **Policies** > **Create policy** > tab **JSON**. Replace the content with:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "InvokeClaudeThroughEuProfiles",
         "Effect": "Allow",
         "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
         "Resource": [
           "arn:aws:bedrock:*:*:inference-profile/eu.anthropic.*",
           "arn:aws:bedrock:*::foundation-model/anthropic.*"
         ]
       }
     ]
   }
   ```

   Both lines under `Resource` are needed: the first allows the EU profile, the second the Claude models the profile routes to. **Next**, name it `adminwise-bedrock-invoke`, **Create policy**.
2. **IAM > Users > Create user**. Name `adminwise-bedrock`. Leave "Provide user access to the AWS Management Console" unticked. **Next**.
3. **Attach policies directly**, search `adminwise-bedrock-invoke`, tick it, **Next**, **Create user**.
4. Open the user > tab **Security credentials** > **Create access key** > use case **Application running outside AWS** > **Next** > description `adminwise app` > **Create access key**.
5. The page shows **Access key** and **Secret access key**. The secret is shown only now. Save both in the password manager, then put them in `.env`:

   ```
   AWS_ACCESS_KEY_ID=<Access key>
   AWS_SECRET_ACCESS_KEY=<Secret access key>
   ```

6. Check it from the `03_Build` folder: `pnpm check:ai` sends one tiny request to each configured model and prints "ok" or AWS's error. It prints no secrets.

If the check says access denied for a model, the model is not enabled for the account yet (Bedrock > Model catalog), or the policy JSON was changed.

## 2. Microsoft Entra

Done: app "Adminwise" in your own tenant. Details and the remaining production step are in `MICROSOFT_SETUP.md`. Values for `.env`: `MS_CLIENT_ID` (Overview > Application (client) ID) and `MS_CLIENT_SECRET` (the secret's **Value**).

Do not connect an employer mailbox while testing; use the mailboxes in your own tenant.

## 3. Postmark

Done: Live server, sending domain verified, MX record for `in.getadminwise.com` points to `inbound.postmarkapp.com` (checked by DNS lookup on 2026-11-10).

Values for `.env`:
- `POSTMARK_SERVER_TOKEN`: the server > **API Tokens** > Server API token.
- `POSTMARK_INBOUND_SECRET`: a password you invent, 40 letters and digits (no `@`, `:`, `/` or `#`, because it travels inside a URL).

Still to do when the app is live (`DEPLOY.md`, step 6): in the server's **Inbound** stream > **Settings**, set the inbound domain to `in.getadminwise.com` and the webhook URL to `https://postmark:<POSTMARK_INBOUND_SECRET>@app.getadminwise.com/api/webhooks/postmark`.

Recommended DNS addition: a DMARC record (none exists yet). In Cloudflare add TXT, name `_dmarc`, content `v=DMARC1; p=none; rua=mailto:hello@getadminwise.com`. It tells receiving mail servers where to report problems; tighten `p=none` to `quarantine` after a few weeks of clean reports.
