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

- [ ] **Pay once in the Stripe sandbox, end to end.** Seen on 23 Nov: plans created in the sandbox, a subscription read correctly through the API (`pnpm check:stripe`), and "choose a plan" opening Stripe's payment page locally. NOT yet seen: a finished payment coming back to the app and making the account active, the "Manage subscription" page, and the webhook. Steps are in docs/DEPLOY.md.
- [ ] **Going live with payments** needs, in this order: Stripe business verification and bank account; the accountant's answers (OSS, rate for EU customers without a VAT number, KSeF for Polish customers, invoice numbering); Stripe Tax set up and `STRIPE_AUTOMATIC_TAX=true`; `pnpm stripe:setup` with the live key; the live webhook endpoint; then `BILLING_ENABLED=true`. Until the last step every account is free with every feature.
- [ ] **Cards only.** Decided on 23 Nov, but Stripe no longer lets the app restrict payment methods: the sandbox payment page also offered Apple Pay and Satispay. In Stripe, Settings, Payment methods, switch off everything except cards (sandbox and live).
- [ ] **Failed payments.** In Stripe (Billing, Revenue recovery) set: retry for about a week, then cancel the subscription. Our side then makes the account read-only. Check once in the sandbox with Stripe's "always declines after attaching" test card.
- [ ] **Mail backlog after read-only.** While an account is read-only its mailbox is not read. When it pays again, the next mailbox check picks up from where it stopped, so mail from the whole read-only period could get drafts at once. Decide before billing goes live: skip the backlog on reactivation, or limit it to the last few days.
- [ ] **Automatic deletion after 60 days read-only** is real deletion with no undo (database backups aside). Tested with a simulated clock only. Watch the first real case by hand.
- [ ] **VAT number from our settings is not passed to Stripe.** The customer enters it again on Stripe's payment page, and Stripe decides the tax. Our own check only informs the customer. Decide with the accountant's answers whether to pass it along or drop one of the two.
- [ ] **Plan change by an internal account.** Our own accounts stay "internal" even if they subscribe; to test the paid flow use a fresh account.

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
- [ ] **AWS Bedrock request limits.** The account's requests-per-minute and tokens-per-minute limits for the two models are not known. Look them up in the AWS console under Service Quotas > Amazon Bedrock, compare with the expected peak (about 6 mails a minute at 100 customers, two to four model calls each), and ask AWS for an increase in time.
- [ ] **Model cost per customer.** The estimate of 1 to 3 euros per active customer per month predates quotes, which add one to three model calls per business mail. Measure from the token counts in `job_runs` after two weeks of real use.
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

- [ ] **Every decision in the decisions log.** For each one: is the reason still valid, did it turn out as intended, would we decide the same today? Includes the architecture cross-check already noted in `06_open_items.md`.
- [ ] **Security and privacy review.** Customer isolation, token storage, the signed links in emails, the webhooks, what is logged, the 24-hour rule in practice (look in the live database for bodies older than a day), what an export or delete request really removes.
- [ ] **Try to break it.** Emails with hidden or fake instructions (scenarios 28 and 29), absurd quantities and prices, a price list built to confuse the column detection, huge attachments, the same mail many times, two workers at once, an expired or revoked mailbox (30 and 31).
- [ ] **Every number in an offer.** Take real offers from the test period and recalculate them by hand against the price list.
- [ ] **Every promise we make to customers.** Check the website copy, the privacy statement and the Settings texts against what the software really does: drafts only, nothing sent, EU processing, the app sees only its own OneDrive folder, deleted within 24 hours.
- [ ] **A full code review** of the repository for bugs, dead code and things that are harder than they need to be.
- [ ] **Everything still open on this list.**

## Known limits, accepted for now

- Docker images are large (worker 3.26 GB with the PDF browser, web about 1.8 GB); builds on Railway take around 10 minutes. Slimming is an open task.
- Public holidays count as working days for follow-ups.
- "Never follow up for this sender" and "choose the item yourself" for an unclear quote are not built.
- Reading details from a sample offer (to prefill offer settings) is not built yet.
- Filing reads the file name and the email, not the file's own content.
