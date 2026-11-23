import { DELETE_AFTER_DAYS, entitlements, EU_COUNTRIES, OTHER_COUNTRY, taxTreatment, trialDaysLeft, type TaxTreatment } from "@adminwise/core";
import { canFile, forCustomer } from "@adminwise/db";
import type { ReactNode } from "react";
import { describeRun, jobName } from "@/lib/activity";
import { requireSession } from "@/lib/auth";
import { getConfig, getDb } from "@/lib/server";
import { PLANS } from "@/lib/site";
import { choosePlan, closeAccount, generateVoiceProfile, manageSubscription, saveBilling, saveSettings, saveVoiceProfile, signOutAction } from "./actions";

export const dynamic = "force-dynamic";

/** The folder Microsoft creates for the app in the customer's OneDrive. */
const APP_FOLDER = "Apps/Adminwise";

const ERRORS: Record<string, string> = {
  languages: "Enter at least one language code, for example: pl, en",
  timezone: "Choose a time zone from the list.",
  followup: "Follow-up days must be a whole number from 1 to 30.",
  replydrafts: "Choose one of the three options for reply drafts.",
  close_confirm: "To close your account, type DELETE in the box.",
  close_subscription: "Your subscription could not be ended at our payment provider, so the account was not closed. Cancel it under Manage subscription and try again.",
  checkout: "The payment page could not be opened, or the payment was not completed. Nothing was charged; please try again.",
  billing_off: "Paid plans have not started yet.",
  billing_country: "Choose your country from the list.",
  vat_format: "That does not look like a VAT number of the country you chose. Check the country and the number.",
  samples: "Paste three complete sent emails (each at least a few lines).",
  ai: "The voice profile could not be built right now. Your emails were not stored; please try again.",
  microsoft: "Microsoft sign-in did not complete. Please try again.",
  microsoft_config: "The Microsoft 365 connection is not set up on this server yet.",
};
const SAVED: Record<string, string> = {
  settings: "Settings saved.",
  voice: "Voice profile saved.",
  subscribed: "Thank you. Your plan is active.",
  billing_none: "Billing details saved.",
  billing_valid: "Billing details saved. Your VAT number is valid.",
  billing_invalid: "Billing details saved, but the EU register does not know this VAT number.",
  billing_unverified: "Billing details saved. The EU register could not be reached, so your VAT number is not checked yet.",
  connected: "Mailbox connected. New mail will get reply drafts from now on.",
};

/** What the billing country and VAT number mean for our invoices to this customer. */
const TAX_LINES: Record<TaxTreatment, string> = {
  unknown: "",
  domestic: "VAT is charged on your invoices at the standard rate.",
  reverse_charge: "No VAT is charged on your invoices: with a valid EU VAT number you account for it yourself (reverse charge).",
  eu_with_vat: "VAT is charged on your invoices. With a valid EU VAT number it would not be.",
  outside_eu: "You are outside the EU: no EU VAT is charged on your invoices.",
};

function Notice({ tone, children }: { tone: "ok" | "error"; children: ReactNode }) {
  const colours = tone === "ok" ? "border-brand-200 bg-brand-50 text-brand-900" : "border-red-200 bg-red-50 text-red-900";
  return <p className={`mb-6 rounded-md border px-4 py-3 text-sm ${colours}`}>{children}</p>;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const config = getConfig();
  const scope = forCustomer(getDb(), session.customerId);
  const [customer, connections, runs, queuedFiling] = await Promise.all([
    scope.getCustomer(),
    scope.listConnections(),
    scope.listJobRuns(10),
    scope.countQueuedFiling(),
  ]);
  const microsoft = connections.find((c) => c.provider === "microsoft");
  const timeZones = Intl.supportedValuesOf("timeZone");
  const tax = taxTreatment(config.sellerCountry, customer.billingCountry, customer.vatStatus);
  const now = new Date();
  const may = entitlements(customer, now, config.billingEnabled);
  const date = (d: Date | null) => d?.toISOString().slice(0, 10) ?? "";

  return (
    <div className="space-y-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="text-sm text-stone-600">Signed in as {session.email}</p>
        </div>
        <form action={signOutAction}>
          <button className="btn-secondary" type="submit">
            Sign out
          </button>
        </form>
      </header>

      {!customer.setupFinishedAt && (
        <p className="rounded-md border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900">
          New here?{" "}
          <a className="font-medium underline" href="/start">
            Open the Getting started guide
          </a>{" "}
          and see your first draft in about ten minutes.
        </p>
      )}
      {!may.work && (
        <Notice tone="error">
          Your account is read-only: nothing new is prepared and your mailbox is not read. Choose a plan below to switch
          everything back on.
        </Notice>
      )}
      {params.saved && SAVED[params.saved] && <Notice tone="ok">{SAVED[params.saved]}</Notice>}
      {params.error && ERRORS[params.error] && <Notice tone="error">{ERRORS[params.error]}</Notice>}

      <section className="card" id="plan">
        <h2 className="text-lg font-semibold">Plan</h2>
        <div className="mt-3 space-y-2 text-sm">
          {!config.billingEnabled && <p>Paid plans have not started yet. Your account is free for now, with every feature.</p>}
          {config.billingEnabled && customer.billingStatus === "internal" && <p>Internal account: free, with every feature.</p>}
          {config.billingEnabled && customer.billingStatus === "trial" && may.work && (
            <p>
              Free trial with everything in the Run plan. It ends on <strong>{date(customer.trialEndsAt)}</strong> (
              {trialDaysLeft(customer.trialEndsAt, now)} days left). Without a plan your account then becomes read-only.
            </p>
          )}
          {config.billingEnabled && customer.billingStatus === "active" && (
            <p>
              You are on the <strong>{customer.plan === "run" ? "Run" : "Start"}</strong> plan.{" "}
              {customer.cancelAtPeriodEnd
                ? `Cancelled: it runs until ${date(customer.currentPeriodEnd)} and then becomes read-only.`
                : customer.currentPeriodEnd && `Paid until ${date(customer.currentPeriodEnd)}; it renews by itself.`}
              {customer.plan === "start" && " Offers, order confirmations and payment reminders are part of the Run plan."}
            </p>
          )}
          {config.billingEnabled && !may.work && (
            <p>
              Read-only{customer.readOnlySince ? ` since ${date(customer.readOnlySince)}` : ""}. Your settings are kept. An
              account that stays read-only is deleted after {DELETE_AFTER_DAYS} days; you get a warning by email a week before.
            </p>
          )}
          {config.billingEnabled && config.stripe && customer.billingStatus === "active" && customer.stripeCustomerId && (
            <form action={manageSubscription}>
              <button className="btn-secondary" type="submit">
                Manage subscription
              </button>
              <p className="hint">Opens our payment provider&apos;s page: change card, switch plan, see invoices or cancel.</p>
            </form>
          )}
          {config.billingEnabled && config.stripe && (customer.billingStatus === "trial" || customer.billingStatus === "read_only") && (
            <div className="grid gap-4 pt-2 sm:grid-cols-2">
              {PLANS.map((plan) => (
                <div key={plan.name} className={`rounded-md border p-4 ${plan.highlighted ? "border-brand-700" : "border-stone-200"}`}>
                  <p className="font-semibold">{plan.name}</p>
                  <p className="text-stone-600">{plan.tagline}</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-stone-700">
                    {plan.features.map((feature) => (
                      <li key={feature}>{feature}</li>
                    ))}
                  </ul>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(["month", "year"] as const).map((interval) => (
                      <form key={interval} action={choosePlan}>
                        <input type="hidden" name="plan" value={plan.name.toLowerCase()} />
                        <input type="hidden" name="interval" value={interval} />
                        <button className={interval === "month" ? "btn" : "btn-secondary"} type="submit">
                          EUR {interval === "month" ? plan.monthly : plan.yearly} / {interval}
                        </button>
                      </form>
                    ))}
                  </div>
                </div>
              ))}
              <p className="hint sm:col-span-2">
                Prices without VAT. You pay on our payment provider&apos;s page (Stripe); your card details never reach{" "}
                {config.appName}. Cancel any time; a plan runs until the end of the period you paid for.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold">Company</h2>
        <form action={saveSettings} className="mt-4 space-y-4">
          <div>
            <label htmlFor="name">Company name</label>
            <input id="name" name="name" type="text" defaultValue={customer.name} required />
          </div>
          <div>
            <label htmlFor="languages">Languages you work in</label>
            <input id="languages" name="languages" type="text" defaultValue={customer.languages.join(", ")} required />
            <p className="hint">
              Two-letter codes, comma-separated: pl, en, de. Mail in any other language still gets a draft, flagged in
              your daily brief.
            </p>
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
            <textarea id="signatureText" name="signatureText" rows={5} defaultValue={customer.signatureText} />
            <p className="hint">Added to the end of every draft.</p>
          </div>
          <div>
            <label htmlFor="replyDrafts">Reply drafts</label>
            <select id="replyDrafts" name="replyDrafts" defaultValue={customer.replyDrafts}>
              <option value="all">For every business email</option>
              <option value="sales">Only for quote requests, accepted offers and replies about unpaid invoices</option>
              <option value="off">None</option>
            </select>
            <p className="hint">
              Which incoming mail gets a reply prepared for you. Follow-ups, filing and payment reminders work the same
              with either of the first two choices. The second choice needs your price list: without one, a quote
              request cannot be recognised and gets no draft. With &quot;None&quot; no replies are prepared at all, so a
              quote request gets no offer either.
            </p>
          </div>
          <div>
            <label htmlFor="followUpDays">Follow up after (working days)</label>
            <input
              id="followUpDays"
              name="followUpDays"
              type="number"
              min={1}
              max={30}
              step={1}
              defaultValue={customer.followUpDays}
              required
            />
            <p className="hint">
              When you wrote last in a conversation and got no answer for this many working days (Monday to Friday), a
              follow-up draft is placed in your Outlook Drafts. At most two per conversation; nothing is sent for you.
              Follow-ups need a connected Microsoft 365 mailbox.
            </p>
          </div>
          <button className="btn" type="submit">
            Save
          </button>
        </form>
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold">Mailbox</h2>
        <div className="mt-4 space-y-5 text-sm">
          <div>
            <p className="font-medium">Microsoft 365 / Outlook</p>
            {!microsoft && <p className="mt-1 text-stone-600">Not connected.</p>}
            {microsoft?.status === "active" && (
              <p className="mt-1">
                <span className="mr-2 inline-block h-2 w-2 rounded-full bg-green-600" />
                Connected: {microsoft.emailAddress}
                {microsoft.lastSyncAt && (
                  <span className="text-stone-500"> (last checked {microsoft.lastSyncAt.toISOString().slice(0, 16).replace("T", " ")} UTC)</span>
                )}
              </p>
            )}
            {microsoft && microsoft.status !== "active" && (
              <p className="mt-1">
                <span className="mr-2 inline-block h-2 w-2 rounded-full bg-red-600" />
                Disconnected: {microsoft.emailAddress}. New mail is not being read until you reconnect.
              </p>
            )}
            <a className="btn mt-3" href="/api/microsoft/connect">
              {microsoft ? "Reconnect Microsoft 365" : "Connect Microsoft 365"}
            </a>
            <p className="hint">Drafts appear in your Outlook Drafts folder. Nothing is ever sent for you.</p>
          </div>
          <div className="border-t border-stone-200 pt-5">
            <p className="font-medium">Filing to OneDrive</p>
            {(!microsoft || microsoft.status !== "active") && (
              <p className="mt-1 text-stone-600">
                Off. Filing needs a connected Microsoft 365 account: attachments are saved in that account&apos;s OneDrive.
              </p>
            )}
            {microsoft?.status === "active" && !canFile(microsoft) && (
              <p className="mt-1">
                <span className="mr-2 inline-block h-2 w-2 rounded-full bg-amber-500" />
                Off. Your mailbox was connected before filing existed. Click <strong>Reconnect Microsoft 365</strong>{" "}
                above once to switch it on; everything else keeps working in the meantime.
              </p>
            )}
            {microsoft?.status === "active" && canFile(microsoft) && !microsoft.driveError && (
              <p className="mt-1">
                <span className="mr-2 inline-block h-2 w-2 rounded-full bg-green-600" />
                On. Attachments are saved to <code className="rounded bg-stone-100 px-1">{APP_FOLDER}</code> in your
                OneDrive.
              </p>
            )}
            {microsoft?.status === "active" && canFile(microsoft) && microsoft.driveError && (
              <p className="mt-1">
                <span className="mr-2 inline-block h-2 w-2 rounded-full bg-red-600" />
                Your OneDrive could not be reached{queuedFiling > 0 ? `, ${queuedFiling} attachment(s) are waiting` : ""}.
                They are filed automatically once it works again. If this stays, reconnect Microsoft 365 above.
              </p>
            )}
            <p className="hint">
              Invoices, orders, contracts and offers from incoming mail go to {APP_FOLDER}/&lt;sender&gt;/&lt;year-month&gt;.
              {" "}
              {config.appName} can only see that one folder, nothing else in your OneDrive. The same file is never saved
              twice.
            </p>
          </div>
          <div className="border-t border-stone-200 pt-5">
            <p className="font-medium">Forwarding address (Gmail and everything else)</p>
            <p className="mt-1">
              <code className="rounded bg-stone-100 px-2 py-1">
                {customer.slug}@{config.inboundDomain}
              </code>
            </p>
            <p className="hint">
              Forward an email to this address and the draft reply comes back to you by email within a minute or two.
              With the forwarding address you get reply drafts only: follow-ups and filing need a connected Microsoft
              365 mailbox.
            </p>
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold">Offers and price list</h2>
        <p className="mt-2 text-sm text-stone-600">
          Upload your price list, set your offer details and discounts. Offers are prepared from your own prices only.
        </p>
        <a className="btn mt-3" href="/settings/offers">
          Open offers and price list
        </a>
      </section>

      <section className="card" id="billing">
        <h2 className="text-lg font-semibold">Billing details</h2>
        <p className="mt-1 text-sm text-stone-600">For the invoices {config.appName} sends you. Not used in your own offers.</p>
        <form action={saveBilling} className="mt-4 space-y-4">
          <div>
            <label htmlFor="billingName">Company name on the invoice</label>
            <input id="billingName" name="billingName" type="text" defaultValue={customer.billingName || customer.name} />
          </div>
          <div>
            <label htmlFor="billingAddress">Address</label>
            <textarea id="billingAddress" name="billingAddress" rows={3} defaultValue={customer.billingAddress} />
          </div>
          <div>
            <label htmlFor="billingCountry">Country</label>
            <select id="billingCountry" name="billingCountry" defaultValue={customer.billingCountry} required>
              <option value="">Choose...</option>
              {Object.entries(EU_COUNTRIES)
                .sort(([, a], [, b]) => a.localeCompare(b))
                .map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              <option value={OTHER_COUNTRY}>Another country (outside the EU)</option>
            </select>
          </div>
          <div>
            <label htmlFor="vatNumber">VAT number</label>
            <input id="vatNumber" name="vatNumber" type="text" defaultValue={customer.vatNumber} placeholder="for example PL1234567890" />
            <p className="hint">
              Checked against the EU&apos;s public VAT register (VIES) each time you save. Only the country and the number
              are sent there. Leave empty if you have none.
            </p>
            {customer.vatStatus === "valid" && (
              <p className="mt-2 text-sm">
                <span className="mr-2 inline-block h-2 w-2 rounded-full bg-green-600" />
                Valid, checked {customer.vatCheckedAt?.toISOString().slice(0, 10)}.
                {customer.vatRegisteredName && <> Registered as: {customer.vatRegisteredName}.</>}
              </p>
            )}
            {customer.vatStatus === "invalid" && (
              <p className="mt-2 text-sm">
                <span className="mr-2 inline-block h-2 w-2 rounded-full bg-red-600" />
                The EU register does not know this number (checked {customer.vatCheckedAt?.toISOString().slice(0, 10)}).
                Check it for typing mistakes, and that it is registered for trade within the EU.
              </p>
            )}
            {customer.vatStatus === "unverified" && (
              <p className="mt-2 text-sm">
                <span className="mr-2 inline-block h-2 w-2 rounded-full bg-amber-500" />
                Not checked yet: the EU register could not be reached. Press Save to try again.
              </p>
            )}
          </div>
          {tax !== "unknown" && <p className="text-sm">{TAX_LINES[tax]}</p>}
          <button className="btn" type="submit">
            Save and check
          </button>
        </form>
      </section>

      <section className="card" id="voice">
        <h2 className="text-lg font-semibold">Voice profile</h2>
        <p className="mt-1 text-sm text-stone-600">How your drafts should sound. Built from three emails you sent; you can edit it.</p>

        {customer.voiceProfile && (
          <form action={saveVoiceProfile} className="mt-4 space-y-3">
            <label htmlFor="voiceProfile">Your profile</label>
            <textarea id="voiceProfile" name="voiceProfile" rows={8} defaultValue={customer.voiceProfile} />
            <button className="btn" type="submit">
              Save profile
            </button>
          </form>
        )}

        <details className="mt-6" open={!customer.voiceProfile}>
          <summary className="cursor-pointer text-sm font-medium text-brand-800">
            {customer.voiceProfile ? "Rebuild from three sent emails" : "Build from three sent emails"}
          </summary>
          <form action={generateVoiceProfile} className="mt-4 space-y-4">
            {[1, 2, 3].map((n) => (
              <div key={n}>
                <label htmlFor={`sample${n}`}>Sent email {n}</label>
                <textarea id={`sample${n}`} name={`sample${n}`} rows={6} required placeholder="Paste a typical email you wrote to a customer" />
              </div>
            ))}
            <button className="btn" type="submit">
              Build my voice profile
            </button>
            <p className="hint">The three emails are read once to describe your style and are not stored.</p>
          </form>
        </details>
      </section>

      <section className="card" id="close">
        <details>
          <summary className="cursor-pointer text-sm font-medium text-stone-700">Close my account</summary>
          <div className="mt-3 space-y-3 text-sm">
            <p>
              This deletes your account and everything {config.appName} stores for it, at once and for good: settings,
              price list, offers, tracked invoices and activity. Files in your own OneDrive and drafts in your own mailbox
              are yours and stay where they are.
            </p>
            <form action={closeAccount} className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="confirm">Type DELETE to confirm</label>
                <input id="confirm" name="confirm" type="text" autoComplete="off" required />
              </div>
              <button className="btn-secondary border-red-300 text-red-800 hover:bg-red-50" type="submit">
                Close account and delete everything
              </button>
            </form>
          </div>
        </details>
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold">Recent activity</h2>
        {runs.length === 0 ? (
          <p className="mt-2 text-sm text-stone-600">Nothing yet.</p>
        ) : (
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-stone-500">
              <tr>
                <th className="py-1 font-medium">When (UTC)</th>
                <th className="py-1 font-medium">What</th>
                <th className="py-1 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t border-stone-100">
                  <td className="py-1">{run.startedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td className="py-1">{jobName(run)}</td>
                  <td className="py-1">{describeRun(run)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
