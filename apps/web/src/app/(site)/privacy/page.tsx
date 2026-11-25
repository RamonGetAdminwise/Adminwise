import type { Metadata } from "next";
import { getConfig } from "@/lib/server";
import { contactEmail } from "@/lib/site";
import { Gap, Heading, LEGAL_READY, LegalPage, SellerLine } from "../legal";

export const metadata: Metadata = { title: "Privacy", robots: LEGAL_READY ? undefined : { index: false } };

/**
 * Every statement here must match what the code does. When a new outside
 * service is added, or what is stored changes, this page changes with it.
 */
const PROCESSORS: { name: string; what: string; sees: string; where: string }[] = [
  {
    name: "Railway",
    what: "Runs the application and its database",
    sees: "Everything we store (listed above)",
    where: "European Union (EU West)",
  },
  {
    name: "Amazon Web Services (Amazon Bedrock)",
    what: "The AI models that classify mail and write drafts",
    sees: "The email or document being worked on and what is needed to answer it (see Artificial intelligence), at that moment. Not kept by AWS, not used to train models",
    where: "European Union (Frankfurt region, EU-only processing)",
  },
  {
    name: "Postmark (ActiveCampaign)",
    what: "Delivers our own emails to you (sign-in links, the daily brief, drafts sent back to you) and receives the emails you forward to us",
    sees: "Those emails, including forwarded customer mail and its attachments",
    where: "United States",
  },
  {
    name: "Microsoft",
    what: "Your own Microsoft 365 mailbox and OneDrive, when you connect them",
    sees: "Nothing new: it is your own account. We read mail and write drafts and files there on your behalf",
    where: "Where your Microsoft 365 account is hosted",
  },
  {
    name: "European Commission (VIES)",
    what: "Checks the VAT number you enter in your billing details",
    sees: "The country code and the VAT number",
    where: "European Union",
  },
  {
    name: "Cloudflare",
    what: "Domain name service for our web addresses",
    sees: "No customer content",
    where: "Worldwide",
  },
];

export default function PrivacyPage() {
  const { appName } = getConfig();
  const email = contactEmail();
  return (
    <LegalPage title="Privacy" updated="24 November 2026">
      <p>
        {appName} prepares drafts and documents for small companies from their business email. This page says in plain
        words what we read, what we keep, for how long, and who else is involved.
      </p>

      <Heading>Who is responsible</Heading>
      <p>
        {appName} is a product of <SellerLine />. Contact: <a className="underline" href={`mailto:${email}`}>{email}</a>.
      </p>
      <p>
        For the content of your mailbox (your emails, and the personal data of your customers in them) you are the
        controller and we are your processor: we handle it only to provide the service to you. A data processing agreement
        is available on request: <Gap>data processing agreement</Gap>. For your account and billing details we are the
        controller.
      </p>

      <Heading>What we read</Heading>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>With a connected Microsoft 365 mailbox:</strong> new mail in your Inbox, the mail in your Sent Items
          (to notice unanswered questions, and PDFs you send that are your own invoices), and attachments of incoming
          mail. Other folders are not read. The permission Microsoft gives us is called &quot;read and write
          mail&quot;: it would technically also allow changing or deleting mail. We use it only to read mail, to
          create drafts, and to remove a draft we created ourselves once it is no longer needed. We also get your
          name and address, and one folder of our own in your OneDrive. We do not have permission to send mail, and
          we cannot reach the rest of your OneDrive.
        </li>
        <li>
          <strong>With the forwarding address:</strong> only the emails you forward to it.
        </li>
        <li>
          <strong>What you give us in settings:</strong> your company details, signature, price list, logo, discounts, the
          addresses that may use your forwarding address, a
          description of your writing style, and sample documents you upload (read once, not stored).
        </li>
      </ul>

      <Heading>What we keep, and for how long</Heading>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>Text of emails and drafts, and the sender&apos;s address:</strong> deleted from our running systems
          within 24 hours. The draft itself stays where it belongs: in your own mailbox. Copies in our database
          backups disappear as those backups expire (see below). Emails that travel through our mail provider
          (forwarded mail, and drafts and briefs we email to you) are also kept by that provider for{" "}
          <Gap>Postmark retention period</Gap>.
        </li>
        <li>
          <strong>About each email, for as long as you have an account:</strong> the sender&apos;s domain, the subject, the
          date, what kind of mail it was, and the names of its attachments. This is what the daily brief and the
          follow-ups work from. For a filed document we also keep the folder it was saved in; for a sender with a
          private mailbox (such as gmail.com) that folder is named after the part of their address before the @.
        </li>
        <li>
          <strong>Documents we make or track:</strong> offers and order confirmations (with their lines and prices), and for
          your invoices the number, amount, dates and buyer name. Filed attachments are stored in your own OneDrive, not
          with us; we keep the file name and where it was saved.
        </li>
        <li>
          <strong>Your settings and account:</strong> everything listed under settings above, your sign-in email, and your
          billing details.
        </li>
        <li>
          <strong>Your request for access:</strong> the company name, your name, your email address, where your business
          email is and what you wrote, from the form on this site. We use it to answer you. If we cannot offer you a
          place it is deleted after 30 days; a request we never decided on, after 90 days; and when you close your
          account, together with everything else.
        </li>
        <li>
          <strong>A log of what the service did:</strong> which job ran, when, and whether it worked. It never contains
          email text.
        </li>
        <li>
          <strong>Backups</strong> of the database are made daily and kept for <Gap>backup retention period</Gap>.
        </li>
      </ul>
      <p>
        When you close your account, your data is deleted within <Gap>number of days</Gap>, except what the law requires us
        to keep (invoices we issued to you).
      </p>

      <Heading>Artificial intelligence</Heading>
      <p>
        Mail is classified and drafts are written by AI models, run for us by Amazon Web Services inside the European
        Union. A model receives the email or document being worked on, and what is needed to answer it: your company
        name, the description of your writing style, the sender&apos;s domain, earlier messages of the same
        conversation while we still hold them, and for a quote request the names of matching items on your price list.
        Prices from your price list are never given to a model; offers are calculated by ordinary software. A payment
        reminder is written from the invoice&apos;s number, amount and due date. Your data is not used to train
        models. Drafts can contain mistakes: every draft is yours to read and to send or not.
      </p>

      <Heading>Who else is involved</Heading>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] text-left">
          <thead className="text-stone-600">
            <tr>
              <th className="py-2 pr-4 font-medium">Company</th>
              <th className="py-2 pr-4 font-medium">What it does for us</th>
              <th className="py-2 pr-4 font-medium">What it sees</th>
              <th className="py-2 font-medium">Where</th>
            </tr>
          </thead>
          <tbody>
            {PROCESSORS.map((p) => (
              <tr key={p.name} className="border-t border-stone-200 align-top">
                <td className="py-2 pr-4 font-medium">{p.name}</td>
                <td className="py-2 pr-4">{p.what}</td>
                <td className="py-2 pr-4">{p.sees}</td>
                <td className="py-2">{p.where}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Postmark processes email in the United States. The legal basis for that transfer is{" "}
        <Gap>transfer mechanism, to confirm with a lawyer</Gap>. A payment provider will be added to this list when paid
        plans start.
      </p>
      <p>We do not sell data, show advertising, or share data with anyone not listed here.</p>

      <Heading>Cookies</Heading>
      <p>
        One cookie keeps you signed in. A second one exists for ten minutes while you connect Microsoft 365, to make
        sure the answer from Microsoft belongs to your request. There are no advertising or tracking cookies, and no
        analytics on this site.
      </p>

      <Heading>Your rights</Heading>
      <p>
        You can ask us what we hold about you, have it corrected or deleted, receive a copy, or object to how it is used.
        Write to <a className="underline" href={`mailto:${email}`}>{email}</a>. You can disconnect your mailbox at any time
        in settings; reading stops at once. You also have the right to complain to the data protection authority; in Poland
        that is the President of the Personal Data Protection Office (UODO).
      </p>

      <Heading>Changes</Heading>
      <p>When this page changes in a way that matters, account holders are told by email before the change applies.</p>
    </LegalPage>
  );
}
