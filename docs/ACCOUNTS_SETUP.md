# Accounts to create, in order

Three outside accounts are needed before the product can do real work. You can run the app and all tests without any of them; they are needed for real AI drafts (AWS), a real mailbox (Microsoft) and real email in and out (Postmark).

Portals rename their menus from time to time; if a label differs slightly, the step is still the same. Use a company email address for all three and store the passwords in your password manager.

## 1. AWS account with Bedrock (the AI) - about 20 minutes, plus possible waiting

1. Go to https://aws.amazon.com and choose **Create an AWS Account**. Enter email, account name, then verify the email.
2. Choose account type **Business**, fill in Ramon Haagen Consulting's details, add a payment card, verify your phone, pick the free **Basic support** plan.
3. Sign in to the console as the root user and immediately turn on MFA: account menu (top right) **> Security credentials > Assign MFA device**.
4. In the region selector (top right) choose **Europe (Frankfurt) eu-central-1**.
5. Search for **Bedrock** and open it. In **Model catalog**, open the Anthropic Claude model you want (default in this project: Claude Opus 5.5). If AWS asks for **use case details** for Anthropic models, fill in the short form (company, website, what you build: "email reply drafts for small businesses"). Approval is usually quick but can take longer.
6. Check that the model is offered in Frankfurt. If the catalog shows it only through an EU inference profile, copy that id and use it as `BEDROCK_MODEL_ID`.
7. Create a key that can do nothing except call models: search **IAM > Users > Create user**, name `backoffice-bedrock`, no console access. **Attach policies directly > Create policy > JSON**:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
         "Resource": "*"
       }
     ]
   }
   ```

   Save it as `backoffice-bedrock-invoke`, attach it to the user.
8. Open the user **> Security credentials > Create access key > Application running outside AWS**. Copy the two values into `.env`: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. The secret is shown once.
9. Protect yourself from surprises: **Billing and Cost Management > Budgets > Create budget**, monthly cost budget of EUR 20 with an email alert at 80 %.

Result: `AWS_REGION=eu-central-1`, `BEDROCK_MODEL_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

## 2. Microsoft Entra tenant (the Outlook connection) - about 20 minutes

You need a tenant to register the app in, and at least one test mailbox to connect.

1. The simplest route that gives both: start a **Microsoft 365 Business Basic** trial at https://www.microsoft.com/microsoft-365/business (one month free, then about EUR 6 per user per month; one user is enough). Use a new name for the tenant, for example the product name; it becomes `<name>.onmicrosoft.com`.
   - If you qualify for the free **Microsoft 365 Developer Program** sandbox (https://developer.microsoft.com/microsoft-365/dev-program) use that instead: it includes test mailboxes at no cost. Microsoft restricted eligibility, so the sign-up page tells you whether you get a sandbox.
2. Finish the wizard; you get an admin account `admin@<name>.onmicrosoft.com` with a mailbox.
3. In https://admin.microsoft.com add one more user with a mailbox (for example `test@<name>.onmicrosoft.com`) so you can send mail between the two.
4. Follow `MICROSOFT_SETUP.md` to register the app in this tenant.

Result: `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT=common`.

Do not register the app in your employer's tenant, and do not connect an employer mailbox while testing.

## 3. Postmark (forwarding addresses and our own outgoing mail) - about 15 minutes, needs the domain

Postmark needs a domain you control, so do this once the product domain is bought. Until then leave the Postmark variables empty: sign-in links are printed in the web app's console and no mail is sent.

1. Sign up at https://postmarkapp.com. New accounts start in test mode (you can only send to your own domain) until Postmark approves them; request approval from the dashboard and describe the mail: "sign-in links, daily summary and reply drafts sent to our own customers".
2. **Servers > Create server**, name it after the product.
3. **Outgoing mail.** **Sender Signatures > Add Domain**, enter the domain, and add the DKIM and Return-Path DNS records Postmark shows at your domain registrar. Set `MAIL_FROM` to an address on that domain.
4. In the server, open **API Tokens** and copy the **Server API token** into `POSTMARK_SERVER_TOKEN`.
5. **Incoming mail.** Decide the inbound subdomain (`in.<your domain>`) and put it in `INBOUND_DOMAIN`. At your registrar add an **MX record** for `in.<your domain>` pointing to `inbound.postmarkapp.com` (priority 10).
6. In the server open the **Inbound** message stream **> Settings**:
   - **Inbound domain**: `in.<your domain>`.
   - Invent a long random password and put it in `POSTMARK_INBOUND_SECRET`.
   - **Webhook URL**: `https://postmark:<that password>@<your app domain>/api/webhooks/postmark`.
   - Press **Check** / send a test once the app is deployed.
7. Add an SPF/DMARC record for the sending domain if your registrar does not have one yet (Postmark's domain page shows what is missing).

Result: `POSTMARK_SERVER_TOKEN`, `POSTMARK_INBOUND_SECRET`, `MAIL_FROM`, `INBOUND_DOMAIN`.

## Also needed for deployment (not for building)

- **GitHub** account and a private repository for this code.
- **Railway** account (https://railway.com), see `DEPLOY.md`.
