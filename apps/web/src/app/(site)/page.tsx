import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSession, landingPath } from "@/lib/auth";
import { getConfig } from "@/lib/server";
import { contactEmail, PLANS, signInUrl, TRIAL_DAYS } from "@/lib/site";

export const dynamic = "force-dynamic";

/**
 * The public home page. Rule for every line on it: it describes what the
 * product does today. What is planned is named once, under "Coming next".
 */

const OUTCOMES: { title: string; lead: string; points: string[] }[] = [
  {
    title: "You get paid on time",
    lead: "Send an invoice as you always do. The reminders write themselves.",
    points: [
      "Your own invoices are recognised when you send them as a PDF, with number, amount and due date.",
      "A reminder is drafted 7, 14 and 30 days after the due date: friendly, then firm, then final.",
      "Every morning you see what is due and what is overdue.",
    ],
  },
  {
    title: "Offers in minutes",
    lead: "A quote request comes in. The offer is waiting in your Drafts.",
    points: [
      "A PDF offer with your logo, built from your own price list. No price is ever estimated.",
      "If an item is unclear, the draft asks the customer instead of guessing.",
      "When the customer accepts, the order confirmation is prepared from the same offer.",
    ],
  },
  {
    title: "Nothing slips through",
    lead: "You asked a customer something and heard nothing. You no longer have to remember.",
    points: [
      "A follow-up is drafted after the number of working days you choose, at most twice per conversation.",
      "Reply drafts in your own tone and in the customer's language, for the mail you choose.",
      "A daily brief at 07:30: what needs you today, what went quiet, what was prepared.",
    ],
  },
  {
    title: "Paperwork files itself",
    lead: "Attachments stop living in your inbox.",
    points: [
      "Invoices, orders, contracts and offers from incoming mail are saved to your OneDrive, by sender and month.",
      "The same file is never saved twice.",
      "Only one folder in your OneDrive is used. The rest of your drive stays out of reach.",
    ],
  },
];

const BUILT_FOR: [string, string][] = [
  ["Traders, importers, distributors", "Quote requests answered from your price list, and overdue invoices chased while you sell."],
  ["Machine and parts dealers", "Offers with the right item codes and prices, and a follow-up on every quote that went quiet."],
  ["Agencies and consultancies", "Polite chasing you never have to write, and client documents filed as they arrive."],
  ["Installers, workshops, service firms", "Payment reminders that go out on time, and one morning email instead of a full inbox."],
];

const QUESTIONS: [string, ReactNode][] = [
  [
    "Will it send emails without me seeing them?",
    "No. Everything is a draft: in your Outlook Drafts folder, or emailed to you. You read it, change it if you like, and press send yourself.",
  ],
  [
    "I am not good with AI. Do I have to write prompts?",
    "Never. You connect your mailbox or forward an email, and the work appears. There is nothing to learn.",
  ],
  [
    "Is it written by AI?",
    "Yes, the texts are drafted by AI, which is why nothing is sent for you. The numbers are not: prices, totals, amounts and dates are taken from your price list and your documents by ordinary code, and anything that cannot be found is left out and asked about.",
  ],
  [
    "What does it work with?",
    "Microsoft 365 (Outlook for work) gets everything: drafts in your own Drafts folder, follow-ups, filing to OneDrive and payment reminders. With Gmail or any other mailbox you forward an email to your personal address with us and get the reply draft or the offer back by email.",
  ],
  [
    "Which languages?",
    "Emails are answered in the language the customer wrote in. Offer documents are available in English and Polish.",
  ],
  [
    "Can it use my own prices and logo?",
    "Yes. You upload your price list as an Excel file and check what was read before it is used. Offers carry your logo, colour and company details, in one of three layouts.",
  ],
  [
    "What if it makes a mistake in an offer?",
    "It drafts, you send. Nothing reaches a customer before you have looked at it. An offer keeps the prices it was made with, also when your price list changes later.",
  ],
  [
    "Is my data safe?",
    <>
      The application and its database run in the European Union, and so does the AI processing. The text of your emails is
      deleted from our systems within 24 hours. Your data is not used to train AI models. The details, including the
      companies we work with, are on the <a className="underline" href="/privacy">privacy page</a>.
    </>,
  ],
];

function Check() {
  return (
    <svg className="mt-1 h-4 w-4 shrink-0 text-teal-700" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8.5l3.2 3.2L13 4.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** What the 07:30 email looks like, with invented companies. */
function BriefExample({ appName }: { appName: string }) {
  const section = "mt-4 text-xs font-semibold uppercase tracking-wide text-stone-500";
  return (
    <figure className="rounded-xl border border-stone-200 bg-white p-5 text-sm shadow-lg">
      <figcaption className="flex items-center justify-between border-b border-stone-200 pb-3">
        <span className="font-semibold">Your brief for Tuesday</span>
        <span className="text-xs text-stone-500">07:30 · example</span>
      </figcaption>
      <p className={section}>Needs you today</p>
      <ul className="mt-1 space-y-1">
        <li>Offer OF/2026/014 for Rolmet is ready in your Drafts.</li>
        <li>Halvorsen Maskin accepted an offer: order confirmation prepared.</li>
      </ul>
      <p className={section}>Money due and overdue</p>
      <ul className="mt-1 space-y-1">
        <li>
          FV/2026/11/0457, 26 372,43 PLN, <span className="font-medium text-red-700">7 days overdue</span>: reminder in
          Drafts.
        </li>
        <li>INV-2026-118, 18 314,70 PLN, due in 3 days.</li>
      </ul>
      <p className={section}>Went quiet</p>
      <ul className="mt-1 space-y-1">
        <li>Stalbud has not answered your question from last Monday: follow-up in Drafts.</li>
      </ul>
      <p className={section}>Filed yesterday</p>
      <ul className="mt-1 space-y-1">
        <li>3 documents saved to your OneDrive.</li>
      </ul>
      <p className="mt-4 border-t border-stone-200 pt-3 text-xs text-stone-500">Nothing was sent for you. {appName}</p>
    </figure>
  );
}

export default async function HomePage() {
  // On the app's own address a signed-in person goes straight to their work.
  const session = await getSession();
  if (session) redirect(await landingPath(session));

  const { appName } = getConfig();
  const signIn = signInUrl();
  const email = contactEmail();

  return (
    <main>
      <section className="bg-stone-50">
        <div className="mx-auto grid max-w-5xl items-center gap-10 px-4 py-16 md:grid-cols-2 md:py-24">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">Your back office, handled.</h1>
            <p className="mt-5 text-lg text-stone-700">
              Offers, payment reminders, follow-ups and filing, prepared for you straight from your inbox, with one overview
              every morning. You keep working in your own mailbox. You check and send; nothing is sent for you.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <a href={signIn} className="btn px-5 py-3 text-base">
                Start free for {TRIAL_DAYS} days
              </a>
              <a href="#what" className="text-sm font-medium text-teal-800 underline">
                See what it does
              </a>
            </div>
            <p className="mt-4 text-sm text-stone-600">No card needed. First draft in about ten minutes. Hosted in the EU.</p>
          </div>
          <BriefExample appName={appName} />
        </div>
      </section>

      <section id="what" className="mx-auto max-w-5xl px-4 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">What it does</h2>
        <p className="mt-2 max-w-2xl text-stone-700">
          The work a small company does at ten in the evening, prepared before you sit down.
        </p>
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {OUTCOMES.map((outcome) => (
            <article key={outcome.title} className="card">
              <h3 className="text-lg font-semibold">{outcome.title}</h3>
              <p className="mt-1 text-sm text-stone-600">{outcome.lead}</p>
              <ul className="mt-4 space-y-2 text-sm">
                {outcome.points.map((point) => (
                  <li key={point} className="flex gap-2">
                    <Check />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="bg-stone-50">
        <div className="mx-auto max-w-5xl px-4 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">How it starts</h2>
          <ol className="mt-8 grid gap-6 md:grid-cols-3">
            {[
              ["Connect your mailbox", "Microsoft 365 with one click. Or skip the connection and forward emails to your personal address with us."],
              ["Show us how you work", "Paste three emails you sent, so drafts sound like you. Upload your price list and a past offer, and your details are read from them."],
              ["See it work", "We send you one test email. The reply draft appears while you watch. Tomorrow at 07:30 your first brief arrives."],
            ].map(([title, text], index) => (
              <li key={title} className="card">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-teal-700 text-sm font-semibold text-white">
                  {index + 1}
                </span>
                <h3 className="mt-3 font-semibold">{title}</h3>
                <p className="mt-1 text-sm text-stone-700">{text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">Built for</h2>
        <dl className="mt-6 grid gap-x-10 gap-y-5 md:grid-cols-2">
          {BUILT_FOR.map(([who, line]) => (
            <div key={who} className="border-l-2 border-teal-700 pl-4">
              <dt className="font-semibold">{who}</dt>
              <dd className="mt-1 text-sm text-stone-700">{line}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section id="plans" className="bg-stone-50">
        <div className="mx-auto max-w-5xl px-4 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">Plans</h2>
          <p className="mt-2 text-stone-700">
            {TRIAL_DAYS} days free on either plan. No card needed, cancel any time.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-2">
            {PLANS.map((plan) => (
              <article key={plan.name} className={`card flex flex-col ${plan.highlighted ? "border-2 border-teal-700" : ""}`}>
                <div className="flex items-center justify-between">
                  <h3 className="text-xl font-semibold">{plan.name}</h3>
                  {plan.highlighted && (
                    <span className="rounded-full bg-teal-700 px-3 py-1 text-xs font-medium text-white">Most chosen</span>
                  )}
                </div>
                <p className="mt-1 text-sm text-stone-600">{plan.tagline}</p>
                <p className="mt-4">
                  <span className="text-4xl font-semibold">EUR {plan.monthly}</span>
                  <span className="text-stone-600"> / month</span>
                </p>
                <p className="text-sm text-stone-600">or EUR {plan.yearly} per year. Prices without VAT.</p>
                <p className="mt-4 text-sm">{plan.intro}</p>
                <ul className="mt-3 flex-1 space-y-2 text-sm">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-2">
                      <Check />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <a href={signIn} className={`mt-6 justify-center ${plan.highlighted ? "btn" : "btn-secondary"}`}>
                  Start free for {TRIAL_DAYS} days
                </a>
              </article>
            ))}
          </div>
          <p className="mt-6 text-sm text-stone-600">
            Follow-ups, filing and payment reminders need a Microsoft 365 mailbox. With any other mailbox you get reply
            drafts and offers by forwarding.
          </p>
          <p className="mt-2 text-sm text-stone-600">
            <strong className="font-medium text-stone-800">Coming next:</strong> a Gmail connection, a web overview next to
            the daily email, and a larger plan for companies with more than one user.
          </p>
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-10 px-4 py-16 md:grid-cols-2">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Why this exists</h2>
          <blockquote className="mt-4 space-y-3 text-stone-700">
            <p>
              I run a small company in Poland. I&apos;m Dutch, so every email, offer and reminder I write is in my second or
              third language, and for years the admin ate my evenings.
            </p>
            <p>
              So I started automating my own back office: offers in minutes, follow-ups that never got forgotten, invoices
              filed before I had seen them. {appName} is that idea, built from the ground up as a product simple enough
              that you never see the machinery.
            </p>
            <p>If it doesn&apos;t give you back your evenings in the first two weeks, don&apos;t pay for it.</p>
          </blockquote>
          <p className="mt-4 text-sm font-medium">Ramon Haagen, founder</p>
        </div>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Your data</h2>
          <ul className="mt-4 space-y-2 text-sm">
            {[
              "The application, its database and the AI processing run in the European Union.",
              "We read only the mailbox you connect or the emails you forward.",
              "The text of your emails is deleted from our systems within 24 hours.",
              "Nothing is ever sent from your mailbox. We do not even ask for the permission to send.",
              "In your OneDrive we can reach one folder of our own, nothing else.",
              "Your data is not used to train AI models.",
            ].map((line) => (
              <li key={line} className="flex gap-2">
                <Check />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-stone-600">
            Who we work with and what each of them sees is listed on the{" "}
            <a className="underline" href="/privacy">
              privacy page
            </a>
            .
          </p>
        </div>
      </section>

      <section id="questions" className="bg-stone-50">
        <div className="mx-auto max-w-3xl px-4 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">Questions</h2>
          <div className="mt-6 divide-y divide-stone-200 border-y border-stone-200">
            {QUESTIONS.map(([question, answer]) => (
              <details key={question} className="group py-4">
                <summary className="cursor-pointer list-none font-medium marker:hidden">
                  <span className="mr-2 inline-block text-teal-700 transition-transform group-open:rotate-90">&rsaquo;</span>
                  {question}
                </summary>
                <p className="mt-2 pl-5 text-sm text-stone-700">{answer}</p>
              </details>
            ))}
          </div>
          <p className="mt-6 text-sm text-stone-700">
            Another question? Write to{" "}
            <a className="underline" href={`mailto:${email}`}>
              {email}
            </a>
            . We answer within one working day.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 py-16 text-center">
        <h2 className="text-3xl font-semibold tracking-tight">Run your company. We prepare the paperwork.</h2>
        <a href={signIn} className="btn mt-6 px-5 py-3 text-base">
          Start free for {TRIAL_DAYS} days
        </a>
        <p className="mt-3 text-sm text-stone-600">No card needed. Cancel any time.</p>
      </section>
    </main>
  );
}
