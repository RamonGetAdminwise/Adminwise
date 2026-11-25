import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MAIL_SYSTEMS, readRequestForm, submitRequest } from "@/lib/access";
import { getConfig } from "@/lib/server";
import { contactEmail, signInUrl } from "@/lib/site";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Request access" };

async function send(formData: FormData) {
  "use server";
  // A field people never see; programs that fill in every field give themselves away.
  if (typeof formData.get("website") === "string" && formData.get("website") !== "") redirect("/request?sent=1");
  const read = readRequestForm(formData);
  if ("error" in read) redirect(`/request?error=${read.error}`);
  const result = await submitRequest(read.input);
  redirect(result === "busy" ? "/request?error=busy" : "/request?sent=1");
}

const ERRORS: Record<string, string> = {
  email: "Enter a valid email address.",
  company: "Enter the name of your company.",
  name: "Enter your name.",
  system: "Choose where your business email is.",
};

export default async function RequestPage({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const params = await searchParams;
  const config = getConfig();
  const contact = contactEmail();

  return (
    <div className="mx-auto max-w-xl px-4 py-14">
      <h1 className="text-3xl font-bold">Request access</h1>
      <p className="mt-3 text-stone-700">
        Tell us who you are and we get back to you within one working day. A person reads every request. After that you
        have 30 days to try {config.appName} with your own mailbox, free and without a card.
      </p>

      <div className="card mt-8">
        {params.sent ? (
          <div>
            <h2 className="text-lg font-semibold">Thank you, we have your request</h2>
            <p className="mt-2">
              We sent a confirmation to your email address. You will hear from us within one working day. Nothing has
              been created yet and nothing is read from your mailbox.
            </p>
            <p className="hint mt-4">
              No email from us within a few minutes? Check the spam folder, or write to{" "}
              <a className="underline" href={`mailto:${contact}`}>
                {contact}
              </a>
              .
            </p>
          </div>
        ) : (
          <form action={send} className="space-y-5">
            {params.error === "busy" && (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                We cannot take your request through this form right now. Please write to {contact} instead.
              </p>
            )}
            <div>
              <label htmlFor="company">Company name</label>
              <input id="company" name="company" type="text" required maxLength={120} autoComplete="organization" placeholder="Nordpart Ltd" />
              {params.error === "company" && <p className="mt-1 text-sm text-red-700">{ERRORS.company}</p>}
            </div>
            <div>
              <label htmlFor="name">Your name</label>
              <input id="name" name="name" type="text" required maxLength={120} autoComplete="name" placeholder="Anna Kowalska" />
              {params.error === "name" && <p className="mt-1 text-sm text-red-700">{ERRORS.name}</p>}
            </div>
            <div>
              <label htmlFor="email">Work email</label>
              <input id="email" name="email" type="email" required autoComplete="email" placeholder="you@company.com" />
              <p className="hint mt-1">You will sign in with this address. There is no password to remember.</p>
              {params.error === "email" && <p className="mt-1 text-sm text-red-700">{ERRORS.email}</p>}
            </div>
            <div>
              <label htmlFor="system">Where is your business email?</label>
              <select id="system" name="system" required defaultValue="">
                <option value="" disabled>
                  Choose one
                </option>
                {Object.entries(MAIL_SYSTEMS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <p className="hint mt-1">Not sure? If you read your mail in Outlook, it is most likely Microsoft 365.</p>
              {params.error === "system" && <p className="mt-1 text-sm text-red-700">{ERRORS.system}</p>}
            </div>
            <div>
              <label htmlFor="note">What would you like help with? (optional)</label>
              <textarea
                id="note"
                name="note"
                rows={4}
                maxLength={1500}
                placeholder="For example: answering quote requests takes my evenings, and I forget to chase late invoices."
              />
            </div>
            {/* Hidden from people; see the action above. */}
            <div aria-hidden="true" className="hidden">
              <label htmlFor="website">Website</label>
              <input id="website" name="website" tabIndex={-1} autoComplete="off" />
            </div>
            <button className="btn" type="submit">
              Send my request
            </button>
            <p className="hint">
              We use these details only to answer your request. If we cannot help you, they are deleted after 30 days.
            </p>
          </form>
        )}
      </div>

      <p className="mt-6 text-sm text-stone-600">
        Already a customer?{" "}
        <a className="underline" href={signInUrl()}>
          Sign in
        </a>
        .
      </p>
    </div>
  );
}
