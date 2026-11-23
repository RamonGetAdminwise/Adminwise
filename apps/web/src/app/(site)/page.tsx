import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSession, landingPath } from "@/lib/auth";
import { getConfig } from "@/lib/server";
import { contactEmail, PLANS, signInUrl, TRIAL_DAYS } from "@/lib/site";
import { BriefMock, FilingMock, OfferMock, RemindersMock } from "./mocks";

export const dynamic = "force-dynamic";

/**
 * The public home page. Rule for every line on it: it describes what the
 * product does today. What is planned is named once, under "Coming next".
 * No customer logos, numbers of users or quotes appear until they are real.
 */

const FEATURES: { id: string; eyebrow: string; title: string; lead: string; points: string[]; mock: ReactNode }[] = [
  {
    id: "paid",
    eyebrow: "Get paid on time",
    title: "Send the invoice. The reminders write themselves.",
    lead: "Your own invoices are recognised when you send them as a PDF, and followed until they are paid.",
    points: [
      "Number, amount and due date are read from the invoice. Anything unclear is asked, never guessed.",
      "A reminder is drafted 7, 14 and 30 days after the due date: friendly, then firm, then final.",
      "Every morning you see what is due and what is overdue.",
    ],
    mock: <RemindersMock />,
  },
  {
    id: "offers",
    eyebrow: "Offers in minutes",
    title: "A quote request comes in. The offer is waiting in your Drafts.",
    lead: "A PDF offer with your logo, built from your own price list, attached to a reply in the customer's language.",
    points: [
      "Every price comes from the price list you uploaded. No price is ever estimated.",
      "If an item is unclear, the draft asks the customer instead of guessing.",
      "When the customer accepts, the order confirmation is prepared from the same offer.",
    ],
    mock: <OfferMock />,
  },
  {
    id: "quiet",
    eyebrow: "Nothing slips through",
    title: "One email at 07:30 tells you what needs you today.",
    lead: "You asked a customer something and heard nothing. You no longer have to remember.",
    points: [
      "A follow-up is drafted after the number of working days you choose, at most twice per conversation.",
      "Reply drafts in your own tone, for the mail you choose: all of it, only sales mail, or none.",
      "What was prepared, what is due, what went quiet and what was filed, in one short brief.",
    ],
    mock: <BriefMock />,
  },
  {
    id: "filing",
    eyebrow: "Paperwork files itself",
    title: "Attachments stop living in your inbox.",
    lead: "Invoices, orders, contracts and offers from incoming mail are saved to your own OneDrive.",
    points: [
      "Sorted by sender and month, with the date and the kind of document in the file name.",
      "Offers and order confirmations you send are filed too.",
      "We can reach one folder in your OneDrive. The rest of your drive stays out of reach.",
    ],
    mock: <FilingMock />,
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
  ["Which languages?", "Emails are answered in the language the customer wrote in. Offer documents are available in English and Polish."],
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
    <svg className="mt-0.5 h-5 w-5 shrink-0" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="10" className="fill-brand-100" />
      <path d="M6 10.4l2.6 2.6L14 7.4" fill="none" className="stroke-brand-700" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
      <section className="bg-gradient-to-b from-brand-50 to-white">
        <div className="mx-auto max-w-6xl px-4 pb-16 pt-14 md:pt-20">
          <div className="mx-auto max-w-3xl text-center">
            <p className="eyebrow">For small companies that run on email</p>
            <h1 className="mt-4 text-4xl font-extrabold text-ink sm:text-6xl">
              Your back office, <span className="text-brand-600">handled.</span>
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-lg text-stone-700">
              Offers, payment reminders, follow-ups and filing, prepared for you straight from your inbox, with one overview
              every morning. You check and send; nothing is sent for you.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <a href={signIn} className="btn px-6 py-3 text-base">
                Start free for {TRIAL_DAYS} days
              </a>
              <a href="#what" className="btn-secondary px-6 py-3 text-base">
                See what it does
              </a>
            </div>
            <p className="mt-4 text-sm text-stone-600">No card needed · First draft in about ten minutes · Hosted in the EU</p>
          </div>

          <div className="mx-auto mt-12 grid max-w-5xl items-start gap-6 md:grid-cols-2">
            <OfferMock />
            <BriefMock />
          </div>

          <div className="mt-12 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm text-stone-600">
            <span className="font-medium text-stone-700">Works with</span>
            {["Microsoft 365", "Outlook", "OneDrive", "Excel price lists", "Gmail and others by forwarding"].map((name) => (
              <span key={name} className="rounded-full border border-stone-200 bg-white px-3 py-1">
                {name}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section id="what" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 md:py-20">
        <div className="max-w-2xl">
          <p className="eyebrow">What it does</p>
          <h2 className="mt-3 text-3xl font-bold sm:text-4xl">The work you do at ten in the evening, prepared before you sit down.</h2>
        </div>
        <div className="mt-12 space-y-16 md:space-y-24">
          {FEATURES.map((feature, index) => (
            <article key={feature.id} className="grid items-center gap-8 md:grid-cols-2 md:gap-14">
              <div className={index % 2 === 1 ? "md:order-2" : ""}>
                <p className="eyebrow">{feature.eyebrow}</p>
                <h3 className="mt-3 text-2xl font-bold sm:text-3xl">{feature.title}</h3>
                <p className="mt-3 text-stone-700">{feature.lead}</p>
                <ul className="mt-5 space-y-3">
                  {feature.points.map((point) => (
                    <li key={point} className="flex gap-3">
                      <Check />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className={`min-w-0 ${index % 2 === 1 ? "md:order-1" : ""}`}>{feature.mock}</div>
            </article>
          ))}
        </div>
      </section>

      <section id="how" className="scroll-mt-20 bg-stone-50">
        <div className="mx-auto max-w-6xl px-4 py-16 md:py-20">
          <p className="eyebrow">How it starts</p>
          <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Set up in one evening. No new software to learn.</h2>
          <ol className="mt-10 grid gap-6 md:grid-cols-3">
            {[
              ["Connect your mailbox", "Microsoft 365 with one click. Or skip the connection and forward emails to your personal address with us."],
              ["Show us how you work", "Paste three emails you sent, so drafts sound like you. Upload your price list and a past offer, and your details are read from them."],
              ["See it work", "We send you one test email. The reply draft appears while you watch. Tomorrow at 07:30 your first brief arrives."],
            ].map(([title, text], index) => (
              <li key={title} className="card">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 font-display text-sm font-bold text-white">
                  {index + 1}
                </span>
                <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-stone-700">{text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 md:py-20">
        <p className="eyebrow">Built for</p>
        <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Companies where the owner is also the back office.</h2>
        <dl className="mt-10 grid gap-5 sm:grid-cols-2">
          {BUILT_FOR.map(([who, line]) => (
            <div key={who} className="rounded-xl border border-stone-200 p-5">
              <dt className="font-display font-semibold">{who}</dt>
              <dd className="mt-1.5 text-sm text-stone-700">{line}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section id="plans" className="scroll-mt-20 bg-stone-50">
        <div className="mx-auto max-w-6xl px-4 py-16 md:py-20">
          <div className="mx-auto max-w-2xl text-center">
            <p className="eyebrow">Plans</p>
            <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Two plans. {TRIAL_DAYS} days free on either.</h2>
            <p className="mt-3 text-stone-700">No card needed to start, and you can cancel any time.</p>
          </div>
          <div className="mx-auto mt-10 grid max-w-4xl gap-6 md:grid-cols-2">
            {PLANS.map((plan) => (
              <article
                key={plan.name}
                className={`flex flex-col rounded-2xl bg-white p-7 ${plan.highlighted ? "border-2 border-brand-600 shadow-xl shadow-brand-900/10" : "border border-stone-200 shadow-sm"}`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-xl font-bold">{plan.name}</h3>
                  {plan.highlighted && <span className="rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white">Most chosen</span>}
                </div>
                <p className="mt-1 text-sm text-stone-600">{plan.tagline}</p>
                <p className="mt-5 flex items-baseline gap-1.5">
                  <span className="font-display text-5xl font-extrabold tabular-nums">€{plan.monthly}</span>
                  <span className="text-stone-600">per month</span>
                </p>
                <p className="mt-1 text-sm text-stone-600">or €{plan.yearly} per year. Prices without VAT.</p>
                <p className="mt-5 text-sm font-medium">{plan.intro}</p>
                <ul className="mt-3 flex-1 space-y-2.5 text-sm">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-3">
                      <Check />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <a href={signIn} className={`mt-7 justify-center py-2.5 ${plan.highlighted ? "btn" : "btn-secondary"}`}>
                  Start free for {TRIAL_DAYS} days
                </a>
              </article>
            ))}
          </div>
          <div className="mx-auto mt-8 max-w-4xl space-y-2 text-sm text-stone-600">
            <p>
              Follow-ups, filing and payment reminders need a Microsoft 365 mailbox. With any other mailbox you get reply
              drafts and offers by forwarding.
            </p>
            <p>
              <strong className="font-semibold text-stone-800">Coming next:</strong> a Gmail connection, a web overview next to
              the daily email, and a larger plan for companies with more than one user.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-10 px-4 py-16 md:grid-cols-2 md:py-20">
        <div>
          <p className="eyebrow">Why this exists</p>
          <blockquote className="mt-4 space-y-4 border-l-4 border-brand-300 pl-5 text-lg text-stone-800">
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
          <p className="mt-4 pl-5 text-sm font-semibold">Ramon Haagen, founder</p>
        </div>
        <div className="rounded-2xl bg-brand-950 p-7 text-brand-100">
          <p className="text-xs font-semibold uppercase tracking-widest text-brand-300">Your data</p>
          <h2 className="mt-3 text-2xl font-bold text-white">Careful by design.</h2>
          <ul className="mt-5 space-y-3 text-sm">
            {[
              "The application, its database and the AI processing run in the European Union.",
              "We read only the mailbox you connect or the emails you forward.",
              "The text of your emails is deleted from our systems within 24 hours.",
              "Nothing is ever sent from your mailbox. We do not even ask for the permission to send.",
              "In your OneDrive we can reach one folder of our own, nothing else.",
              "Your data is not used to train AI models.",
            ].map((line) => (
              <li key={line} className="flex gap-3">
                <svg className="mt-0.5 h-5 w-5 shrink-0" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M5 10.4l3.2 3.2L15 6.6" fill="none" className="stroke-brand-300" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="mt-5 text-sm text-brand-200">
            Who we work with and what each of them sees is on the{" "}
            <a className="font-medium text-white underline" href="/privacy">
              privacy page
            </a>
            .
          </p>
        </div>
      </section>

      <section id="questions" className="scroll-mt-20 bg-stone-50">
        <div className="mx-auto max-w-3xl px-4 py-16 md:py-20">
          <p className="eyebrow">Questions</p>
          <h2 className="mt-3 text-3xl font-bold sm:text-4xl">What people ask first.</h2>
          <div className="mt-8 space-y-3">
            {QUESTIONS.map(([question, answer]) => (
              <details key={question} className="group rounded-xl border border-stone-200 bg-white px-5 py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-display font-semibold">
                  {question}
                  <span className="text-xl leading-none text-brand-600 transition-transform group-open:rotate-45" aria-hidden="true">
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm text-stone-700">{answer}</p>
              </details>
            ))}
          </div>
          <p className="mt-6 text-sm text-stone-700">
            Another question? Write to{" "}
            <a className="font-medium underline" href={`mailto:${email}`}>
              {email}
            </a>
            . We answer within one working day.
          </p>
        </div>
      </section>

      <section className="bg-white px-4 py-16">
        <div className="mx-auto max-w-5xl rounded-3xl bg-brand-600 px-6 py-14 text-center text-white">
          <h2 className="text-3xl font-extrabold sm:text-4xl">Run your company. We prepare the paperwork.</h2>
          <p className="mx-auto mt-3 max-w-xl text-brand-50">Try it with your own mailbox. If it does not give you your evenings back, don&apos;t pay for it.</p>
          <a href={signIn} className="mt-7 inline-flex items-center rounded-lg bg-white px-6 py-3 font-semibold text-brand-800 shadow-sm hover:bg-brand-50">
            Start free for {TRIAL_DAYS} days
          </a>
          <p className="mt-3 text-sm text-brand-100">No card needed · Cancel any time</p>
        </div>
      </section>
    </main>
  );
}
