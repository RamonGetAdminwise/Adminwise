# Microsoft 365 connection: Entra app registration

One app registration serves all customers. Each customer signs in with their own Microsoft 365 account and approves the permissions below; we never see their password. Menu names in the Entra portal change now and then; the steps are the same.

Status 2026-11-10: steps 1, 3 and 4 are done (app "Adminwise" in your own tenant, multitenant for organisations, the four delegated permissions, a client secret, the localhost redirect URI). Open: step 2, the production redirect URI `https://app.getadminwise.com/api/microsoft/callback`, once the app is live.

## 1. Register the app

1. Go to https://entra.microsoft.com and sign in as an administrator.
2. **Identity > Applications > App registrations > New registration**.
3. Name: the product name (customers see it on the consent screen).
4. Supported account types: **Accounts in any organizational directory (Multitenant)**. Do not include personal Microsoft accounts for now.
5. Redirect URI: platform **Web**, value `http://localhost:3000/api/microsoft/callback`.
6. **Register**. On the Overview page copy the **Application (client) ID** into `MS_CLIENT_ID`.

## 2. Add the production redirect URI (when deployed)

**Authentication > Web > Add URI**: `https://app.getadminwise.com/api/microsoft/callback`. Keep the localhost one for development. The value must match `APP_BASE_URL` + `/api/microsoft/callback` exactly.

## 3. Create a client secret

**Certificates & secrets > Client secrets > New client secret**. Choose 24 months. Copy the **Value** (not the Secret ID) into `MS_CLIENT_SECRET` straight away: it is shown once. Put the expiry date in your calendar; when it expires, every connection stops until a new secret is set.

## 4. Permissions

**API permissions > Add a permission > Microsoft Graph > Delegated permissions**, add:

| Permission | Why |
| --- | --- |
| `User.Read` | read the address of the mailbox that was connected |
| `Mail.Read` | read incoming mail |
| `Mail.ReadWrite` | create reply drafts in the Drafts folder |
| `offline_access` | keep working after the customer closes the browser (refresh token) |
| `Files.ReadWrite.AppFolder` | phase 2 filing: save attachments in the app's own OneDrive folder, `Apps/Adminwise` |

Do **not** add `Mail.Send`: the product never sends from a customer's mailbox. Do **not** add `Files.ReadWrite`: the app-folder permission is enough and keeps the rest of the customer's OneDrive closed to us.

### The OneDrive permission (added in phase 2)

`Files.ReadWrite.AppFolder` lets the app read and write one folder that Microsoft creates for it, `Apps/Adminwise` in the customer's OneDrive, and nothing else in their drive. Microsoft's documentation is contradictory about work accounts and labels the permission "preview", so it was tested on a real work mailbox on 2026-11-23 with `pnpm check:drive`: granted without administrator approval; uploads into nested folders, refusal of a second file with the same name, and large uploads all work; listing the rest of the drive returns nothing; searching and writing outside the folder are refused. Run `pnpm check:drive` again (it needs port 3000 free and the localhost redirect URI) before the first outside customer, and whenever Microsoft changes the permission.

To add it to the app registration: **API-machtigingen** > **Een machtiging toevoegen** > **Microsoft Graph** > **Gedelegeerde machtigingen** > search `Files.ReadWrite.AppFolder` > tick it > **Machtigingen toevoegen**. No administrator consent is needed.

Mailboxes that were connected before this permission existed keep working exactly as before. Filing stays off for them until the customer clicks **Reconnect Microsoft 365** once; the Settings page says so, and the daily brief says so on a day an attachment could not be filed.

These are delegated permissions that an ordinary user can approve for their own mailbox, unless their organisation requires administrator approval; in that case their IT administrator approves once.

## 5. Environment variables

```
MS_CLIENT_ID=<Application (client) ID>
MS_CLIENT_SECRET=<client secret value>
MS_TENANT=common
```

## 6. Try it

1. Start the app (README, "Run locally"), sign in, open Settings.
2. **Connect Microsoft 365**, sign in with a test mailbox, approve.
3. Settings shows "Connected: <address>". Send a mail to that mailbox from another account; within 5 minutes (polling) a reply draft appears in its Drafts folder.

## How new mail reaches us

- **Change notifications (webhook).** After connecting, the worker subscribes to "message created in Inbox" and Microsoft calls `https://app.getadminwise.com/api/webhooks/graph` within seconds. Microsoft only calls public https addresses, so this is off on localhost. Subscriptions expire; the worker renews them daily.
- **Polling fallback.** Every 5 minutes the worker asks each mailbox what arrived since last time. This works everywhere, including localhost, and catches anything a notification missed. The same mail seen by both is stored once.
- **Sent Items (phase 2).** The same 5-minute poll also notes what the customer sent, so the follow-up chaser knows who wrote last in a conversation. Sent mail never gets a draft and is never filed.

## When a connection breaks

If Microsoft rejects the refresh token (password change, access revoked, consent removed), the connection is marked "needs reconnect", the Settings page shows it in red, the daily brief lists it with a link, and the customer clicks **Reconnect Microsoft 365**. Mail that arrived in between is picked up by the first poll after reconnecting.

## Before real customers (later, not needed to build)

- **Publisher verification**: in **Branding & properties**, add a verified publisher (needs a Microsoft Partner Center account for the company; free). Without it, customers in other organisations see an "unverified" warning and many tenants block consent.
- Fill in the terms of service and privacy statement URLs on the same page.
