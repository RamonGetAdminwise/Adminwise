import { setupTestMail, setupTestState, testMailWouldBeInternal } from "@adminwise/core";
import { forCustomer } from "@adminwise/db";
import type { ReactNode } from "react";
import { describeRun } from "@/lib/activity";
import { requireSession } from "@/lib/auth";
import { getConfig, getDb } from "@/lib/server";
import { generateVoiceProfile } from "../settings/actions";
import { uploadSampleOffer } from "../settings/offers/actions";
import { finishSetup, saveCompany, sendTestMail } from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  name: "Enter your company name.",
  languages: "Enter at least one language code, for example: pl, en",
  timezone: "Choose a time zone from the list.",
  samples: "Paste three complete sent emails (each at least a few lines).",
  ai: "Your writing style could not be worked out right now. Your emails were not stored; please try again.",
  test_wait: "A test email was sent a moment ago. Give it two minutes before sending another.",
  test_internal: "The test email cannot be used with your address. Send yourself an email from another address instead, as described below.",
  sample: "Choose a PDF of at most 5 MB.",
  sample_unreadable: "This PDF holds no text we can read (a scan or a photo?). You can type your details on the offers page instead.",
  sample_nothing_found: "No company details were found in this document. You can type them on the offers page instead.",
  sample_failed: "The document could not be read right now. Nothing was stored; please try again.",
};
const SAVED: Record<string, string> = {
  company: "Saved.",
  connected: "Mailbox connected.",
  voice: "Your writing style is saved. You can read and change it in settings.",
  test: "Test email sent.",
};

function Notice({ tone, children }: { tone: "ok" | "error"; children: ReactNode }) {
  const colours = tone === "ok" ? "border-brand-200 bg-brand-50 text-brand-900" : "border-red-200 bg-red-50 text-red-900";
  return <p className={`rounded-md border px-4 py-3 text-sm ${colours}`}>{children}</p>;
}

function Step({ id, number, title, done, optional, children }: { id: string; number: number; title: string; done: boolean; optional?: boolean; children: ReactNode }) {
  return (
    <section className="card" id={id}>
      <h2 className="flex items-center gap-3 text-lg font-semibold">
        <span
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm ${done ? "bg-green-600 text-white" : "border border-stone-300 text-stone-600"}`}
          aria-label={done ? "done" : "to do"}
        >
          {done ? "✓" : number}
        </span>
        {title}
        {optional && !done && <span className="text-sm font-normal text-stone-500">optional</span>}
      </h2>
      <div className="mt-4 space-y-4 text-sm">{children}</div>
    </section>
  );
}

export default async function StartPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const session = await requireSession();
  const params = await searchParams;
  const config = getConfig();
  const scope = forCustomer(getDb(), session.customerId);
  const [customer, connections, users, runs, priceList] = await Promise.all([
    scope.getCustomer(),
    scope.listConnections(),
    scope.listUsers(),
    scope.listJobRuns(30),
    scope.getPriceListByStatus("active"),
  ]);
  const microsoft = connections.find((c) => c.provider === "microsoft" && c.status === "active");
  const forwardingAddress = `${customer.slug}@${config.inboundDomain}`;
  const timeZones = Intl.supportedValuesOf("timeZone");

  const test = setupTestState(customer.setupTestSentAt, runs, new Date());
  const testRun = customer.setupTestSentAt
    ? runs.find((r) => r.job === "reply-draft" && r.startedAt >= customer.setupTestSentAt! && r.status === "succeeded")
    : undefined;
  const canSendTest = !testMailWouldBeInternal(config.mailFrom, [...users.map((u) => u.email), ...connections.map((c) => c.emailAddress)]);
  const testMail = setupTestMail(customer.languages, config.appName);

  const done = {
    company: customer.name.trim() !== "",
    mailbox: Boolean(microsoft),
    voice: customer.voiceProfile.trim() !== "",
    test: test === "drafted",
    offers: Boolean(priceList),
  };

  return (
    <div className="space-y-6">
      {/* While the test mail is on its way the page looks again by itself. */}
      {test === "waiting" && <meta httpEquiv="refresh" content="15" />}

      <header>
        <h1 className="text-2xl font-semibold">Getting started</h1>
        <p className="mt-1 text-sm text-stone-600">
          Four short steps, about ten minutes, and you see your first reply draft. {config.appName} prepares drafts and
          documents for you to check; it never sends anything from your mailbox. Drafts are written by AI: always read
          them before you send.
        </p>
      </header>

      {params.saved && SAVED[params.saved] && <Notice tone="ok">{SAVED[params.saved]}</Notice>}
      {params.error && ERRORS[params.error] && <Notice tone="error">{ERRORS[params.error]}</Notice>}

      <Step id="company" number={1} title="Your company" done={done.company}>
        <form action={saveCompany} className="space-y-4">
          <div>
            <label htmlFor="name">Company name</label>
            <input id="name" name="name" type="text" defaultValue={customer.name} required />
          </div>
          <div>
            <label htmlFor="languages">Languages you work in</label>
            <input id="languages" name="languages" type="text" defaultValue={customer.languages.join(", ")} required />
            <p className="hint">Two-letter codes, comma-separated: pl, en, de.</p>
          </div>
          <div>
            <label htmlFor="timeZone">Time zone</label>
            <select id="timeZone" name="timeZone" defaultValue={customer.timeZone}>
              {timeZones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            <p className="hint">Your daily brief arrives at 07:30 in this time zone.</p>
          </div>
          <div>
            <label htmlFor="signatureText">Email signature</label>
            <textarea id="signatureText" name="signatureText" rows={4} defaultValue={customer.signatureText} />
            <p className="hint">Added to the end of every draft. Plain text: your name, company and phone number are enough.</p>
          </div>
          <button className={done.company ? "btn-secondary" : "btn"} type="submit">
            Save
          </button>
        </form>
      </Step>

      <Step id="mailbox" number={2} title="Your mailbox" done={done.mailbox}>
        {microsoft ? (
          <p>
            Connected: <strong>{microsoft.emailAddress}</strong>. New mail is read from now on, and drafts appear in your
            Outlook Drafts folder.
          </p>
        ) : (
          <>
            <p>
              <strong>Microsoft 365 or Outlook for work:</strong> connect it and drafts appear in your own Drafts folder.
              Follow-ups, filing to OneDrive and payment reminders need this connection.
            </p>
            <a className="btn" href="/api/microsoft/connect">
              Connect Microsoft 365
            </a>
            <p>
              <strong>Gmail or anything else:</strong> no connection needed. Forward an email to{" "}
              <code className="rounded bg-stone-100 px-2 py-1">{forwardingAddress}</code> and the draft comes back to you
              by email. You get reply drafts and offers this way; the other features need Microsoft 365.
            </p>
          </>
        )}
      </Step>

      <Step id="voice" number={3} title="How you write" done={done.voice} optional>
        {done.voice ? (
          <p>Done. Drafts follow your own style. You can read and change the description in settings.</p>
        ) : (
          <form action={generateVoiceProfile} className="space-y-4">
            <input type="hidden" name="from" value="start" />
            <p>
              Paste three emails you sent to customers. They are read once to describe your greeting, tone and closing,
              and are not stored. Without this step drafts are polite but do not sound like you.
            </p>
            {[1, 2, 3].map((n) => (
              <div key={n}>
                <label htmlFor={`sample${n}`}>Sent email {n}</label>
                <textarea id={`sample${n}`} name={`sample${n}`} rows={5} required placeholder="Paste a typical email you wrote to a customer" />
              </div>
            ))}
            <button className="btn" type="submit">
              Describe my style
            </button>
          </form>
        )}
      </Step>

      <Step id="test" number={4} title="See it work" done={done.test}>
        {test === "drafted" && (
          <p>
            <strong>It works.</strong>{" "}
            {testRun?.outcome?.endsWith(":email")
              ? "The draft was emailed to you."
              : "The draft is in your Outlook Drafts folder, as a reply to the test email."}{" "}
            Read it, then delete it: the test email came from us, so there is nobody to answer.
          </p>
        )}
        {test === "waiting" && (
          <p>
            <strong>Test email sent.</strong>{" "}
            {microsoft
              ? "It should arrive in your inbox now, and the draft follows within a minute or two. This page checks by itself."
              : `It is in your inbox. Forward it to ${forwardingAddress} and the draft comes back by email within a minute or two.`}
          </p>
        )}
        {test === "no_draft" && testRun && (
          <p>
            Mail arrived, but no draft was written. {describeRun(testRun)}. Try once more, or send yourself an email from
            another address.
          </p>
        )}
        {test === "nothing_arrived" && (
          <p>
            Nothing has arrived yet.{" "}
            {microsoft
              ? "Check that the test email is in your inbox (also the junk folder), then try again."
              : `Did you forward the test email to ${forwardingAddress}?`}
          </p>
        )}
        {test !== "drafted" && canSendTest && (
          <>
            {test === "not_sent" && (
              <p>
                We send one invented customer question to{" "}
                <strong>{microsoft ? microsoft.emailAddress : session.email}</strong>.{" "}
                {microsoft
                  ? "A reply draft then appears in your Outlook Drafts folder."
                  : `Forward it to ${forwardingAddress} and the reply draft comes back to you by email.`}{" "}
                Nothing is sent to anyone else.
              </p>
            )}
            <form action={sendTestMail}>
              <button className={test === "not_sent" ? "btn" : "btn-secondary"} type="submit" disabled={!done.company}>
                {test === "not_sent" ? "Send me the test email" : "Send it again"}
              </button>
              {!done.company && <p className="hint">Save step 1 first.</p>}
            </form>
          </>
        )}
        {test !== "drafted" && (
          <details>
            <summary className="cursor-pointer font-medium text-brand-800">Or try it with an email of your own</summary>
            <p className="mt-2">
              {microsoft
                ? `From another address (a private one, not a colleague's), send this to ${microsoft.emailAddress}:`
                : `Forward any customer email to ${forwardingAddress}, or send this text there:`}
            </p>
            <pre className="mt-2 whitespace-pre-wrap rounded-md bg-stone-100 p-3 text-xs">
              {`Subject: ${testMail.subject}

${testMail.textBody}`}
            </pre>
            <p className="hint">
              Mail from your own company&apos;s addresses gets no draft on purpose: colleagues are not customers.
            </p>
          </details>
        )}
      </Step>

      <Step id="offers" number={5} title="Offers from your price list" done={done.offers} optional>
        <p>
          When someone asks for a quote, {config.appName} can prepare the offer as a PDF with your prices. That needs your
          price list (Excel) and your company details.
        </p>
        <form action={uploadSampleOffer} className="space-y-2">
          <input type="hidden" name="from" value="start" />
          <label htmlFor="sample">Start from a past offer or invoice of yours (PDF)</label>
          <input id="sample" name="sample" type="file" accept="application/pdf,.pdf" required />
          <button className="btn-secondary" type="submit">
            Read my details from this file
          </button>
          <p className="hint">
            Your company details, bank details, payment terms, currency and VAT rate are read and shown to you first.
            The file is not stored.
          </p>
        </form>
        <p>
          <a className="underline" href="/settings/offers">
            Open offers and price list
          </a>{" "}
          to upload your price list and logo.
        </p>
      </Step>

      <section className="card">
        <h2 className="text-lg font-semibold">What happens next</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
          <li>New customer mail gets a reply draft. In settings you choose for which mail: all, only sales mail, or none.</li>
          <li>Every morning at 07:30 you get a brief: what needs you today, money due, and what went quiet.</li>
          {microsoft && <li>Invoices, orders and contracts from incoming mail are filed in your OneDrive, in the folder Apps/{config.appName}.</li>}
          {microsoft && <li>When you send an invoice as a PDF, it is tracked, and a payment reminder is drafted 7, 14 and 30 days after its due date.</li>}
        </ul>
        <form action={finishSetup} className="mt-5">
          <button className={done.test ? "btn" : "btn-secondary"} type="submit">
            {done.test ? "Finish" : "Skip for now"}
          </button>
          <p className="hint">Everything on this page can also be done later in settings.</p>
        </form>
      </section>
    </div>
  );
}
