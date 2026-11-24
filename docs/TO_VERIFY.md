# To verify later

Things that are built but not yet proven, or that were proven only once or only in tests. Each line says what is unknown, how to check it, and when it matters. Tick an item off with the date and the result; add new ones as they come up.

Last updated: 2026-11-23.

## Seen working in production (for reference)

- Sign-in mail, voice profile, Outlook mailbox connection, reply drafts (16 Nov)
- Forwarding address: draft mailed back (16 Nov)
- Filing an attachment to `Apps/Adminwise` in OneDrive (23 Nov)
- Price list upload with the customer's own Excel, offer PDF attached to a draft, logo on the offer (23 Nov)

## Check in the coming days

- [ ] **Follow-up chaser, live.** Never seen in production. Check: with the follow-up period set to 1, a follow-up draft appears in Concepten the next working morning after 06:00 for an unanswered question sent from the connected mailbox. Then set the period back to 5.
- [ ] **Full daily brief, live.** Check the 07:30 brief for the sections "went quiet", "filed yesterday" and "offers and orders prepared yesterday", and that the links in it open.
- [ ] **"Not this time" and "Never for this thread" links.** Press each once from a real brief; the waiting draft should disappear from Concepten.
- [ ] **Order confirmation, live.** Reply "please go ahead" to an offer from the private address; an order confirmation PDF should be attached to the next draft. Also press "prepare the order confirmation" from a brief once.
- [ ] **Offers for forwarding-address customers, live.** Forward a quote request to the forwarding address; the draft and the PDF should come back by email.
- [x] **Railway backups switched on.** Daily schedule is on (confirmed by Ramon, 23 Nov).
- [ ] **Railway backup restore.** Do one test restore before real customer data exists: a backup that was never restored is not proven.
- [ ] **Mail to hello@getadminwise.com arrives.** The alias was added on 23 Nov and not tested; DMARC reports and replies to product mail go there.
- [ ] **Operator alert mail.** Never seen live, because nothing has failed. Check once that a failure produces one mail to `ALERT_EMAIL` (for example after a deliberate failure in a test environment).
- [x] **`fixtures/random/price-list-random.xlsx` in the repository.** Committed by mistake on 23 Nov. It holds invented data only (confirmed by Ramon, 23 Nov), so it stays.
- [ ] **Worker memory on Railway with the PDF browser.** One offer at a time works. Watch the worker's memory and restarts when several offers are made close together.

- [ ] **Payment reminders, live (phase 4, not deployed yet).** After deployment: send an invoice PDF from the connected mailbox, check under Recent activity that it is tracked with the right number, amount and due date, and that the brief lists it. Then check a reminder draft appears 7 days after the due date (or use an invoice that is already overdue).
- [ ] **Getting started guide, live (phase 4, not deployed yet).** After deployment, sign in with an address that has no account yet: you should land on the guide. Do the four steps and press "Send me the test email"; the draft should appear and step 4 should tick itself. Seen working locally on 23 Nov, except the test mail itself, which was not sent from the local machine.
- [ ] **Test mail delivery.** The guide's test mail is sent by Postmark to the owner's own mailbox. Check that it lands in the inbox and not in junk, for a Microsoft 365 mailbox and for a Gmail address.
- [ ] **Forwarded invoice, live.** Forward an invoice PDF to the Adminwise address and check it is tracked. This path runs in the web app's webhook and is covered by tests only up to the point where Postmark calls it.

## Check before the first outside customer

- [ ] **Golden set: answers on the borderline vary between runs.** On 23 Nov the real model agreed with every fixture of all three companies after the prompt fixes, but along the way single answers flipped from one run to the next ("payroll for 2 employees": matched or unclear; a hostile notice: business or notification; the guide's test mail: business or notification). The fixtures were made unambiguous where that happened. In real mail such cases will occur: the cautious outcome (ask, or no draft) is the designed one. Before customers, run the golden set five times in a row and list every answer that is not the same all five times.
- [ ] **Drafts are not in the golden set yet.** It checks decisions, not the wording of drafts. The spec asks for the drafts to be compared after each prompt change, with Ramon reviewing the differences. To add: save the drafts of a fixed sample and show what changed.
- [ ] **Quantity: only a written "one" counts.** "A brochure" or "een website" is 1; "the price of pump PZ-40" is asked about. In languages without articles (Polish) a single piece will therefore be asked about more often than in English or Dutch. Check with real mail whether that is too cautious.

- [x] **The two new test companies with the real model (golden set): done 23 Nov, see below.** Original note: The month of mail for the accounting office and the agency passes with a model stand-in. Not yet run with the real model. Points most likely to differ: whether "een poster" or "a brochure" is read as quantity 1; whether "about 25 documents a month" is matched to the package "up to 30"; whether the polite hostile mails in Polish and Dutch are flagged.
- [ ] **"One is meant": units written differently.** The rule (one is meant for monthly, yearly, project and one-off items) was confirmed by Ramon on 23 Nov. Remaining risk: a unit written differently ("p/m", "abonament") is not recognised and the draft asks "how many" as before.
- [ ] **Database encoding at the next deployment.** The system now refuses to start on a database that is not UTF-8. Railway's Postgres is expected to be UTF-8; if the first build after this change fails to start with a message about text encoding, that is why.
- [ ] **Local development database.** A local database created before 23 Nov has a Windows text encoding and will be refused: delete the folder `%LOCALAPPDATA%\adminwise-dev-postgres` and start `pnpm dev:db` again.
- [ ] **Website contact form.** A form mail from a no-reply address gets no draft, even when it contains a quote request (shown by mail V032 of Studio Veld). Decide: recognise the customer's own website form, or leave it.
- [ ] **An answer in a new mail.** When the other side answers a question in a new mail instead of in the conversation, the follow-up is still drafted (mail V047 of Studio Veld). Decide whether a new mail from the same person should hold the follow-up.
- [ ] **Offer documents in more languages.** English and Polish only; a Dutch customer's offers are in English.
- [ ] **Free mail address in the fixtures.** One invented client writes from an invented wp.pl mailbox, to test free mail providers. Nothing is ever sent to it. Replace it if you prefer no real mail domain in the fixtures at all.

- [ ] **Hostile email: wider test.** Three invented mails were checked with the real model on 23 Nov (`pnpm check:security`): both hostile ones were flagged, the ordinary one was not, and the drafts did not carry out the hostile text. That is a first check. Before customers: twenty more variants in several languages, including instructions hidden in a forwarded mail and in a PDF's text, and count the false alarms on a hundred ordinary mails.
- [ ] **Hidden text in HTML mail.** Mail is read as plain text. Text hidden in the HTML version (white on white, zero size) therefore reaches the model like any other text and is covered by the same defences, but this was tested with text only, not with a real HTML mail through Microsoft or Postmark.
- [ ] **Suspicious mail and filing.** A flagged mail gets no draft, but its attachments are still filed to OneDrive (filing does not act on what a mail says). Decide whether attachments of flagged mail should be held back.
- [ ] **Export format.** The spec asks for a zip; the export is one JSON file. Check with the first customers whether that is enough, or whether a spreadsheet per table is wanted.
- [ ] **Deletion and backups.** Closing an account deletes the live data at once. Copies remain in the daily database backups until those expire; the retention period must be stated on the privacy page (a gap is marked there).

- [ ] **Pay once in the Stripe sandbox, end to end.** Seen on 23 Nov: plans created in the sandbox, a subscription read correctly through the API (`pnpm check:stripe`), and "choose a plan" opening Stripe's payment page locally. NOT yet seen: a finished payment coming back to the app and making the account active, the "Manage subscription" page, and the webhook. Steps are in docs/DEPLOY.md.
- [ ] **Going live with payments** needs, in this order: Stripe business verification and bank account; the accountant's answers (OSS, rate for EU customers without a VAT number, KSeF for Polish customers, invoice numbering); Stripe Tax set up and `STRIPE_AUTOMATIC_TAX=true`; `pnpm stripe:setup` with the live key; the live webhook endpoint; then `BILLING_ENABLED=true`. Until the last step every account is free with every feature.
- [ ] **Cards only.** Decided on 23 Nov, but Stripe no longer lets the app restrict payment methods: the sandbox payment page also offered Apple Pay and Satispay. In Stripe, Settings, Payment methods, switch off everything except cards (sandbox and live).
- [ ] **Failed payments.** In Stripe (Billing, Revenue recovery) set: retry for about a week, then cancel the subscription. Our side then makes the account read-only. Check once in the sandbox with Stripe's "always declines after attaching" test card.
- [ ] **Mail backlog after read-only.** While an account is read-only its mailbox is not read. When it pays again, the next mailbox check picks up from where it stopped, so mail from the whole read-only period could get drafts at once. Decide before billing goes live: skip the backlog on reactivation, or limit it to the last few days.
- [ ] **Automatic deletion after 60 days read-only** is real deletion with no undo (database backups aside). Tested with a simulated clock only. Watch the first real case by hand.
- [ ] **VAT number from our settings is not passed to Stripe.** The customer enters it again on Stripe's payment page, and Stripe decides the tax. Our own check only informs the customer. Decide with the accountant's answers whether to pass it along or drop one of the two.
- [ ] **Plan change by an internal account.** Our own accounts stay "internal" even if they subscribe; to test the paid flow use a fresh account.

- [ ] **Logo files for print.** House style and logo were confirmed by Ramon on 23 Nov (docs/BRAND.md). The logo files hold the wordmark as live text; before print or use outside the site, convert the letters to outlines. A trademark search for the name is still open and applies to the logo too.
- [ ] **Fonts at build time.** The two typefaces are downloaded from Google when the app is built (not when a visitor opens it). Check the first Railway build after this change succeeds.
- [ ] **Website: read every line once.** The copy was rewritten on 23 Nov to promise only what works today (two plans instead of three, no dashboard, no automatic sending, no Gmail connection). Ramon to read the home page and say what is wrong or missing.
- [ ] **Website: founder note wording.** The sentence "This is that system" from the copy of 9 Nov was changed to "Adminwise is that idea, built from the ground up as a product", and "other owners asked for it" was left out, because the product is a new codebase and the claim could not be checked. Ramon to confirm or reword.
- [ ] **Website: the trial promise.** The site says "14 days free, no card needed, cancel any time". None of that exists until Stripe is built: today an account is simply free. Do not point the public domain at the site before billing works, or accept that early accounts are free.
- [ ] **Website: "we answer within one working day".** Promised for mail to hello@getadminwise.com. Check the alias delivers and that someone reads it daily.
- [ ] **Privacy and terms are drafts.** Gaps to fill: registered address and NIP, data processing agreement, backup retention period, deletion period after closing an account, payment provider and failed payments, refund rule, limitation of liability, governing law. Then have a lawyer read both, and set `LEGAL_READY` to true.
- [ ] **REVIEW BEFORE GOING LIVE TO REAL CUSTOMERS: Postmark processes email in the United States.** Decided by Ramon on 23 Nov: keep Postmark for now, review before the first real customer. Forwarded customer mail, drafts emailed back, the daily brief and sign-in links pass through Postmark's US servers. The site therefore says "hosted in the EU" and "AI processing in the EU", not "your data stays in the EU", and the privacy page names Postmark as US. At the review, choose: keep it and have a lawyer state the transfer basis on the privacy page (a gap is marked there), or replace it with an EU mail provider (inbound and outbound mail setup and DNS to redo). Customers with a connected Microsoft 365 mailbox are affected least.
- [ ] **Deletion when an account is closed** is promised on the privacy page and not built: there is no "close my account" function yet.

- [ ] **Invoice reading on real invoices.** Five invented PDFs made by our own generator were read correctly by the real model (`pnpm check:invoices`, 23 Nov). Real invoices from invoicing programs look different: test with ten real ones from different programs, including one with several dates on it.
- [ ] **Company details from real documents.** Reading the seller's details from a sample PDF was checked with the real model on one invented invoice (`pnpm check:setup`, 23 Nov). Try five real offers and invoices from different programs, and note how often a buyer's line slips in (the owner sees the proposal before it is used).
- [ ] **VAT treatment, with the accountant.** The four cases in `taxTreatment` (domestic, reverse charge, EU with VAT, outside the EU) are the general rule and were not checked by a tax adviser. Confirm them, the rate for EU customers without a VAT number, and the wording on the invoice, before the first paid invoice. Confirm `SELLER_COUNTRY`.
- [ ] **VAT check with a real valid number.** Seen live against the EU register on 23 Nov only with a made-up number (answer: not known) and a wrongly shaped one. Save your own VAT number once and check it shows as valid with the right registered name.
- [ ] **VAT number re-check over time.** A number is checked when billing details are saved. A number can stop being valid later, and "unverified" is only retried when the owner saves again. Add a re-check before each invoice when Stripe is built.
- [ ] **"Paid" said by a debtor.** A sender writing "paid" stops the reminders. Check in the first weeks how often that is wrong, and whether the owner notices the line in the brief.

- [ ] **Speed and capacity with many customers.** Tested: 50 mails within one minute for one customer, with a stand-in model. Not tested: many customers at once, or the real model under load. Do a load test with the real model (for example 100 mails across 10 test customers) and note mails per minute and failures.
- [ ] **Load test done on 24 Nov (01_Project_docs/13_load_test_2026-11-24.md): raise the AWS limit, then repeat.** 100 mails for 10 customers were all handled correctly at about 30 a minute and one cent a mail; AWS refused about 90 requests, which now wait instead of failing. Still to do: ask AWS for a higher limit, repeat with 500 mails, and test against a real Microsoft mailbox.
- [x] **AWS request limit is low: seen on 23 Nov (measured in the load test above).** Running the golden set with six model calls at once was refused by AWS ("429 Too many requests") within seconds; two at a time with waiting worked. The worker handles five mails at once, each with two to four model calls, so a busy minute for a handful of customers could already hit this limit. Mail is retried, so nothing is lost, but drafts would arrive late. Ask AWS for a higher limit before the first outside customer, and measure in the load test.
- [ ] **AWS Bedrock request limits.** The account's requests-per-minute and tokens-per-minute limits for the two models are not known. Look them up in the AWS console under Service Quotas > Amazon Bedrock, compare with the expected peak (about 6 mails a minute at 100 customers, two to four model calls each), and ask AWS for an increase in time.
- [x] **Model cost per customer: measured on 24 Nov at about one cent a mail (load test).** Earlier note: The estimate of 1 to 3 euros per active customer per month predates quotes, which add one to three model calls per business mail. Measure from the token counts in `job_runs` after two weeks of real use.
- [ ] **OneDrive app-folder permission.** `Files.ReadWrite.AppFolder` was verified on one work account on 23 Nov; Microsoft labels it "preview" and documents it inconsistently. Run `pnpm check:drive` again, and once with an account in another Microsoft 365 organisation.
- [ ] **"Shared" label on filed documents.** OneDrive showed "Shared" on a filed file although Manage access listed only the owner. Re-check with the first pilot mailbox.
- [ ] **Quality of quote matching with the real model.** Nine invented quote mails agreed with expectations on 23 Nov (`pnpm check:quotes`). That is a first check. Widen it with the golden set in phase 5, including real-looking price lists without item codes.
- [ ] **Price list columns found by the model.** For lists without clear column titles the model proposes the columns. Check with five real customer lists that the preview shows the right name and price columns, and note which layouts fail.
- [ ] **Voice profile built from one language.** A profile built from English emails produced an English greeting on a Polish reply. Check after rebuilding the profile from mixed-language samples; decide whether the profile should be per language.
- [ ] **Microsoft publisher verification.** Parked until customer zero. Needs the registered business details, a `getadminwise.com` contact address, and the privacy and terms pages.
- [ ] **Replace the secrets shown in a screenshot on 23 Nov.** A screenshot of `.env` in the chat showed the AWS access key and secret, the Microsoft client secret, the Postmark server token and the Postmark inbound secret. Make new ones for all four and update both `.env` and the Railway variables: AWS (IAM user `adminwise-bedrock`: create a new access key, delete the old one), Microsoft Entra (new client secret, delete the old one), Postmark (regenerate the server token; new inbound password in the webhook address).
- [ ] **Inbound secrets.** The production and the local `POSTMARK_INBOUND_SECRET` were shown in chat; replace both.
- [ ] **Point-in-time recovery** in Railway: decide whether to switch it on in addition to daily backups.
- [ ] **DMARC.** Now `p=none`. After a few weeks of clean reports, tighten to `p=quarantine`.
- [ ] **Layout of the emails, with the signature (to build, asked for on 23 Nov).** Drafts are plain text with a plain-text signature from settings. The customer's own Outlook signature (logo, fonts, links) is not used, and a draft does not look like a mail they wrote themselves. To work out: formatted (HTML) drafts, a signature with logo, or leaving the signature to Outlook; the same for drafts emailed to forwarding customers.
- [ ] **"Sales mail only" without a price list.** With that choice a quote request is only recognised when a price list is confirmed; without one it gets no draft. Decide whether such a customer should get an ordinary reply draft for quote requests.
- [ ] **Real signature and offer details.** Settings still hold test values (signature "test").

## At the very end: challenge everything we built

Asked for by Ramon on 23 Nov: when the whole v1 is built, and before the first outside customer, go through all of it once more with the aim of finding what is wrong, not confirming what works. Done by a fresh pair of eyes (a separate review session that did not write the code), not by the session that built it.

- [x] **Every decision in the decisions log.** For each one: is the reason still valid, did it turn out as intended, would we decide the same today? Includes the architecture cross-check already noted in `06_open_items.md`.
- [x] **Security and privacy review.** Customer isolation, token storage, the signed links in emails, the webhooks, what is logged, the 24-hour rule in practice (look in the live database for bodies older than a day), what an export or delete request really removes.
- [x] **Try to break it.** Emails with hidden or fake instructions (scenarios 28 and 29), absurd quantities and prices, a price list built to confuse the column detection, huge attachments, the same mail many times, two workers at once, an expired or revoked mailbox (30 and 31).
- [x] **Every number in an offer.** Take real offers from the test period and recalculate them by hand against the price list.
- [x] **Every promise we make to customers.** Check the website copy, the privacy statement and the Settings texts against what the software really does: drafts only, nothing sent, EU processing, the app sees only its own OneDrive folder, deleted within 24 hours.
- [x] **A full code review** of the repository for bugs, dead code and things that are harder than they need to be.
- [x] **Everything still open on this list.**

**Done on 24 Nov 2026** by five fresh reviewers. Report: `01_Project_docs/14_independent_review_2026-11-24.md`. 44 faults fixed, 36 new tests. What it left open:

Ramon's decisions on report section B (taken and built 24 Nov; see the decisions log):
- [x] Forwarding address: only mail from the customer's own listed addresses is taken in.
- [x] Money links in the brief need sign-in.
- [x] Invoice mailed to someone who is not the buyer: asked once in the brief.
- [x] A skipped follow-up does not count.
- [x] Reminder timing said honestly in brief, guide and pages.
- [x] Filing: everything of 10 KB or more, as before.
- [ ] Repeated free trials: accepted for now; look again when billing is switched on.

To verify live after deploying this version:
- [x] Seen live on 24 Nov: mail from a listed hotmail address is taken in, after the sender check was changed to also accept a valid signature of the sender's domain.
- [x] A mail with a larger attachment (490 kB PDF) from the same address was refused at 17:53 UTC: such mails get no signature report, and the handover check was misread (address in quotes). Fixed; taken in live at 18:10 UTC.
- [x] Seen live on 24 Nov, 18:26 UTC: a made-up invoice with the account's company as seller, sent to the forwarding address, is tracked for payment (after dates with the month as a word were accepted). An invoice issued by another company was rightly not tracked.
- [x] Seen live on 24 Nov, 18:30 UTC: a mail from an address that is not listed is refused with the reason "not on your list", no draft. Tomorrow's brief must mention the refused mail.
- [x] Seen live on 24 Nov: Disconnect in settings shows the mailbox as disconnected with access removed, and filing as off; connecting again shows it as connected. Not yet seen: a "Mailbox check" line and filing back on after the reconnect.
- [ ] The first test invoice (2026-0042) waits for its due date: tomorrow's brief must ask for it.
- [ ] Still to try: a mail from an address that is NOT listed (must be refused and mentioned in the next brief); an invoice PDF sent to the forwarding address (must be tracked); if a Gmail or Outlook forwarding RULE is used, add that mailbox in settings and check that rule-forwarded mail comes in. The rule case rests on the envelope sender Postmark reports and was not tried against a real mailbox.
- [ ] A money link from a real brief while signed out: sign-in is asked, and after signing in the link opens. If the sign-in mail is opened in another browser or on the phone, the way back is lost and the link must be clicked again (accepted).
- [ ] An invoice mailed to an address that is not the buyer's: the question appears in the next brief, both answers work.
- [ ] A mail really forwarded by the owner is still recognised as theirs (the new sender check reads Postmark's `Received-SPF` header; if Postmark does not send it, behaviour is as before). Forward one mail with an invoice PDF and check it is tracked.
- [ ] Migration 011 on the production database (reminder drafts get their invoice; drafts unique index replaced).
- [ ] The queue's new retry settings are applied to the existing queues (`updateQueue` at start).
- [ ] Move a mail the follow-up is about to another folder: is the follow-up still drafted? (Microsoft changes the id on a move; we do not ask for immutable ids yet.)
- [ ] `Disconnect` in settings with a real mailbox: reading stops, reconnecting works. Not seen in a browser yet (it needs a connected mailbox); covered by a test at the data layer.
- [ ] Production starts with the stricter configuration check (APP_BASE_URL and POSTMARK_SERVER_TOKEN must be set on BOTH services).

Before the first outside customer (report section C):
- [x] Worker heartbeat and status page `/api/status` (built 24 Nov; seen in a browser in both states with the local database).
- [ ] After deploying: open `https://app.getadminwise.com/api/status`. It must say `"ok":true`. This is the first time the real worker writes its sign of life through the queue; locally only the job itself was run.
- [ ] Ramon: create the uptime monitor (steps in `docs/DEPLOY.md`, "The alarm from outside") and test it once: stop the worker in Railway for ten minutes and wait for the warning.
- [ ] Push `phase-4` to GitHub (it exists only in OneDrive until then).
- [ ] Replace the five leaked secrets AFTER this version is live. Microsoft: create the new secret, set it in Railway, then delete the old one.
- [ ] Look at the production `customers` table before deploying: migration 009 makes every existing account "internal" (free, for ever).
- [ ] Backup retention at Railway and message retention at Postmark: set, then fill the two gaps on the privacy page.
- [ ] Tighten the invoice field checks (amount inside a larger number, sale date as due date, currency sign without code, "N days" phrases that are not payment terms).
- [ ] A cap on mail per customer per day, and a limit on model calls shared by all customers.
- [ ] Outlook draft in one step (today a failed middle step leaves an empty reply in Drafts, one per retry).
- [ ] Read forwarded invoice PDFs in the worker, not in the web request.
- [ ] Row-level security in Postgres as a second lock, and a test that walks every scoped query for two customers.
- [ ] PDF printer as a non-root user; later its own service.
- [ ] One page of rules each: support access to production, rotating the token key, changing the model.
- [ ] Tests for the web app (sign-in, webhooks, export, close account).

Before billing is switched on (report section D):
- [ ] Two subscriptions on one Stripe customer; hourly re-read of Stripe for accounts past their period end and before deleting; delete the Stripe customer on closing; Stripe on the privacy page.

## Known limits, accepted for now

- Docker images are large (worker 3.26 GB with the PDF browser, web about 1.8 GB); builds on Railway take around 10 minutes. Slimming is an open task.
- Public holidays count as working days for follow-ups.
- "Never follow up for this sender" and "choose the item yourself" for an unclear quote are not built.
- Reading details from a sample offer (to prefill offer settings) is not built yet.
- Filing reads the file name and the email, not the file's own content.
