import { canFile, forCustomer } from "@adminwise/db";
import type { ReactNode } from "react";
import { describeRun, jobName } from "@/lib/activity";
import { requireSession } from "@/lib/auth";
import { getConfig, getDb } from "@/lib/server";
import { generateVoiceProfile, saveSettings, saveVoiceProfile, signOutAction } from "./actions";

export const dynamic = "force-dynamic";

/** The folder Microsoft creates for the app in the customer's OneDrive. */
const APP_FOLDER = "Apps/Adminwise";

const ERRORS: Record<string, string> = {
  languages: "Enter at least one language code, for example: pl, en",
  timezone: "Choose a time zone from the list.",
  followup: "Follow-up days must be a whole number from 1 to 30.",
  replydrafts: "Choose one of the three options for reply drafts.",
  samples: "Paste three complete sent emails (each at least a few lines).",
  ai: "The voice profile could not be built right now. Your emails were not stored; please try again.",
  microsoft: "Microsoft sign-in did not complete. Please try again.",
  microsoft_config: "The Microsoft 365 connection is not set up on this server yet.",
};
const SAVED: Record<string, string> = {
  settings: "Settings saved.",
  voice: "Voice profile saved.",
  connected: "Mailbox connected. New mail will get reply drafts from now on.",
};

function Notice({ tone, children }: { tone: "ok" | "error"; children: ReactNode }) {
  const colours = tone === "ok" ? "border-teal-200 bg-teal-50 text-teal-900" : "border-red-200 bg-red-50 text-red-900";
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

  return (
    <div className="space-y-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{config.appName}</h1>
          <p className="text-sm text-stone-600">Signed in as {session.email}</p>
        </div>
        <form action={signOutAction}>
          <button className="btn-secondary" type="submit">
            Sign out
          </button>
        </form>
      </header>

      {!customer.setupFinishedAt && (
        <p className="rounded-md border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-900">
          New here?{" "}
          <a className="font-medium underline" href="/start">
            Open the Getting started guide
          </a>{" "}
          and see your first draft in about ten minutes.
        </p>
      )}
      {params.saved && SAVED[params.saved] && <Notice tone="ok">{SAVED[params.saved]}</Notice>}
      {params.error && ERRORS[params.error] && <Notice tone="error">{ERRORS[params.error]}</Notice>}

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
          <summary className="cursor-pointer text-sm font-medium text-teal-800">
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
