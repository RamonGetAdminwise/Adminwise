import type { Metadata } from "next";
import { getConfig } from "@/lib/server";
import { contactEmail, PLANS, TRIAL_DAYS } from "@/lib/site";
import { Gap, Heading, LEGAL_READY, LegalPage, SellerLine } from "../legal";

export const metadata: Metadata = { title: "Terms", robots: LEGAL_READY ? undefined : { index: false } };

export default function TermsPage() {
  const { appName } = getConfig();
  const email = contactEmail();
  return (
    <LegalPage title="Terms of service" updated="23 November 2026">
      <p>
        These terms apply between you, a business customer, and <SellerLine /> (&quot;we&quot;), for the use of {appName}.
        {" "}
        {appName} is offered to businesses, not to consumers.
      </p>

      <Heading>What the service does</Heading>
      <p>
        {appName} reads the business mailbox you connect, or the emails you forward, and prepares drafts and documents for
        you: replies, follow-ups, offers, order confirmations and payment reminders. It files attachments to your own
        storage and sends you a daily overview. What is included depends on your plan, as described on our website.
      </p>

      <Heading>Drafts are prepared by AI, and you decide</Heading>
      <ul className="list-disc space-y-1 pl-5">
        <li>Texts are drafted by artificial intelligence and can contain mistakes.</li>
        <li>Nothing is sent to your customers by us. You read every draft and document, and you send it or not.</li>
        <li>
          You are responsible for what you send, including the prices, terms and statements in it, and for the price list
          and details you give us.
        </li>
        <li>
          {appName} is not accounting, tax or legal advice, and it does not replace your invoicing or bookkeeping system.
        </li>
      </ul>

      <Heading>Your account</Heading>
      <p>
        You sign in with a link sent to your email address. Keep access to that mailbox safe. You may only connect
        mailboxes and storage you are entitled to use for your business.
      </p>

      <Heading>Trial, plans and payment</Heading>
      <ul className="list-disc space-y-1 pl-5">
        <li>You can try {appName} free for {TRIAL_DAYS} days, without a payment card.</li>
        <li>
          After the trial, the plans cost{" "}
          {PLANS.map((p) => `EUR ${p.monthly} per month or EUR ${p.yearly} per year (${p.name})`).join(", and ")}, without
          VAT. VAT is added according to your country and VAT number.
        </li>
        <li>
          Payment is in advance, per month or per year, through our payment provider. <Gap>payment provider and what
          happens when a payment fails</Gap>
        </li>
        <li>
          You can cancel at any time; the service then runs until the end of the period you paid for.{" "}
          <Gap>refund rule</Gap>
        </li>
        <li>We may change prices for future periods and tell you at least 30 days before.</li>
      </ul>

      <Heading>What you may not do</Heading>
      <p>
        Do not use {appName} for unlawful purposes, to send unsolicited bulk mail, to process mail you have no right to
        process, or to try to get at other customers&apos; data or disturb the service.
      </p>

      <Heading>Your data</Heading>
      <p>
        Your data stays yours. How we handle it is described on the{" "}
        <a className="underline" href="/privacy">
          privacy page
        </a>
        , which is part of these terms. Where we process personal data of your contacts for you, we do so as your processor.
      </p>

      <Heading>Availability</Heading>
      <p>
        We work to keep the service running and to tell you about problems, but we do not promise that it is free of
        interruptions or errors. It depends on services of others, such as your mailbox provider.
      </p>

      <Heading>Liability</Heading>
      <p>
        <Gap>limitation of liability, to be written by a lawyer</Gap>
      </p>

      <Heading>Ending</Heading>
      <p>
        You can close your account at any time. We may suspend or end an account that breaks these terms or is not paid. When
        an account ends, its data is deleted as described on the privacy page.
      </p>

      <Heading>Law and disputes</Heading>
      <p>
        <Gap>governing law and court, to be written by a lawyer</Gap>
      </p>

      <Heading>Contact</Heading>
      <p>
        Questions about these terms: <a className="underline" href={`mailto:${email}`}>{email}</a>.
      </p>
    </LegalPage>
  );
}
