import { addDays, localClock, QUEUES, startOfLocalDay, workingDaysBetween } from "@adminwise/core";
import {
  canFile,
  forCustomer,
  signLinkToken,
  system,
  type DraftSummary,
  type FiledDocument,
  type MailboxConnection,
  type QuietThread,
} from "@adminwise/db";
import { daysBetween, formatMoney } from "@adminwise/offers";
import { briefStrings } from "../brief-strings";
import { allowed, describeError, mayTryAgain, type Deps } from "../deps";
import { chaseCustomer, MAX_CHASERS } from "./chaser";
import { APP_FOLDER } from "./filing";
import { invoiceAmount, remindCustomer } from "./reminders";

/** 07:30 in the customer's own time zone. */
export const BRIEF_MINUTE_OF_DAY = 7 * 60 + 30;
/** How long the "not this time" / "never" links in a brief keep working. */
const LINK_DAYS = 30;
/** Open invoices are listed while overdue, and from this many days before their due date. */
const DUE_SOON_DAYS = 7;
const MAX_MONEY_LINES = 15;

/**
 * Runs every minute. Queues a brief for each customer whose local clock has
 * reached 07:30 and who has not had today's brief yet.
 */
export async function briefTick(deps: Deps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  let queued = 0;
  const sys = system(deps.db);
  const failures = await sys.dailyFailures(new Date(now.getTime() - 36 * 3_600_000));
  for (const customer of await sys.listCustomerClocks()) {
    if (!allowed(deps, customer).work) continue;
    const clock = localClock(now, customer.timeZone);
    if (clock.minutesOfDay < BRIEF_MINUTE_OF_DAY) continue;
    if (customer.briefLastSentOn && customer.briefLastSentOn >= clock.date) continue;
    if (!mayTryAgain(failures.get(`${customer.id}|daily-brief|${clock.date}`), now)) continue;
    await deps.queue.send(QUEUES.sendBrief, { customerId: customer.id, localDate: clock.date });
    queued++;
  }
  return queued;
}

export interface BriefInput {
  appName: string;
  appBaseUrl: string;
  localDate: string;
  /** Reply drafts prepared yesterday. */
  drafts: DraftSummary[];
  /** Offers and order confirmations made yesterday. `confirmUrl` is null once an offer was accepted. */
  offers?: { kind: "offer" | "order_confirmation"; number: string; recipientDomain: string; grossTotal: string; confirmUrl: string | null }[];
  /** Money: open invoices that are overdue or due within a week, questions for the owner, and "we paid" notices to verify. */
  money?: {
    invoices: {
      number: string;
      who: string;
      amount: string;
      dueDate: string;
      /** Positive = overdue; zero or negative = still to come. */
      daysOverdue: number;
      /** The reminder drafted this morning, if any. */
      reminder: { level: number; inOutlook: boolean } | null;
      /** Set when the next reminder was due this morning but this one still sits unsent in Drafts. */
      waitingLevel?: number | null;
      manageUrl: string;
    }[];
    toAsk: (
      | { kind: "due_date"; number: string; who: string; amount: string; url: string }
      | { kind: "confirm"; number: string; who: string; amount: string; sentTo: string; url: string }
      | { kind: "unreadable"; fileName: string }
    )[];
    paidBySender: { number: string; who: string; amount: string }[];
  };
  /** Threads that went quiet, each with how long and the two links for the customer. */
  quiet?: (QuietThread & { workingDaysQuiet: number; skipUrl: string; neverUrl: string })[];
  /** Documents filed yesterday. */
  filed?: Pick<FiledDocument, "docType" | "storedPath">[];
  /** Mail from yesterday that tried to instruct an automated assistant: no draft was written for it. */
  suspicious?: { subject: string; senderDomain: string }[];
  /** Mailboxes that must be reconnected. */
  problems: Pick<MailboxConnection, "provider" | "emailAddress" | "status">[];
  /** Attachments that arrived yesterday and were not filed because the mailbox was connected before filing existed. */
  filingOffCount?: number;
  /** Attachments waiting because OneDrive cannot be reached; 0 = no problem. */
  driveQueuedCount?: number;
  /** Mails to the forwarding address yesterday that were refused: not from one of the customer's own addresses. */
  refusedForwardCount?: number;
  /** Language of the brief's own texts. Only "en" exists for now. */
  language?: string;
}

/** The brief's text. Sections with nothing in them are left out; with nothing at all it is one line. */
export function composeBrief(input: BriefInput): { subject: string; textBody: string } {
  const t = briefStrings(input.language);
  const settingsUrl = `${input.appBaseUrl}/settings`;
  const quiet = input.quiet ?? [];
  const filed = input.filed ?? [];
  const sections: string[] = [];

  if (input.drafts.length > 0) {
    const lines = input.drafts.map((d) => {
      const line =
        d.destination === "outlook_drafts"
          ? t.needsYou.replyInOutlook(d.subject, d.senderDomain)
          : t.needsYou.replyByEmail(d.subject, d.senderDomain);
      const flag = d.languageListed ? "" : t.needsYou.unlistedLanguage(t.languageNames[d.language ?? ""] ?? d.language ?? "?");
      return line + flag;
    });
    sections.push([t.needsYou.heading(input.drafts.length), ...lines].join("\n"));
  }

  const offers = input.offers ?? [];
  if (offers.length > 0) {
    const lines = offers.flatMap((o) => {
      if (o.kind === "order_confirmation") return [t.offers.orderConfirmation(o.number, o.recipientDomain)];
      // An offer that already has its order confirmation needs nothing more.
      if (o.confirmUrl === null) return [t.offers.accepted(o.number, o.recipientDomain)];
      return [t.offers.offer(o.number, o.recipientDomain, o.grossTotal), t.offers.confirmLink(o.confirmUrl)];
    });
    sections.push([t.offers.heading(offers.length), ...lines].join("\n"));
  }

  const money = input.money;
  if (money && money.invoices.length + money.toAsk.length + money.paidBySender.length > 0) {
    const shown = money.invoices.slice(0, MAX_MONEY_LINES);
    const lines = [
      ...shown.flatMap((m) => [
        m.daysOverdue > 0
          ? t.money.overdue(m.number, m.who, m.amount, m.dueDate, m.daysOverdue)
          : t.money.dueSoon(m.number, m.who, m.amount, m.dueDate),
        ...(m.reminder ? [m.reminder.inOutlook ? t.money.reminderInOutlook(m.reminder.level) : t.money.reminderByEmail(m.reminder.level)] : []),
        ...(m.waitingLevel ? [t.money.reminderWaiting(m.waitingLevel)] : []),
        ...(m.daysOverdue > 0 ? [t.money.paidLink(m.manageUrl)] : []),
      ]),
      ...(money.invoices.length > shown.length ? [t.money.more(money.invoices.length - shown.length)] : []),
      ...money.toAsk.map((a) =>
        a.kind === "due_date"
          ? t.money.askDueDate(a.number, a.who, a.amount, a.url)
          : a.kind === "confirm"
            ? t.money.askConfirm(a.number, a.who, a.amount, a.sentTo, a.url)
            : t.money.unreadable(a.fileName),
      ),
      ...money.paidBySender.map((p) => t.money.paidBySender(p.number, p.who, p.amount)),
    ];
    const count = money.invoices.length + money.toAsk.length + money.paidBySender.length;
    sections.push([t.money.heading(count), ...lines].join("\n"));
  }

  if (quiet.length > 0) {
    const lines = quiet.flatMap((q) =>
      q.chaserReady
        ? [
            t.wentQuiet.chaserReady(q.subject, q.counterpartDomain, q.workingDaysQuiet),
            t.wentQuiet.notThisTime(q.skipUrl),
            t.wentQuiet.neverForThread(q.neverUrl),
          ]
        : [t.wentQuiet.noMoreChasers(q.subject, q.counterpartDomain, MAX_CHASERS)],
    );
    if (quiet.some((q) => q.chaserReady)) lines.push(t.wentQuiet.deleteHint);
    sections.push([t.wentQuiet.heading(quiet.length), ...lines].join("\n"));
  }

  if (filed.length > 0) {
    const lines = filed.map((f) => {
      const path = f.storedPath ?? "";
      const slash = path.lastIndexOf("/");
      return t.filed.document(
        t.documentTypes[f.docType ?? "other"] ?? t.documentTypes.other!,
        path.slice(slash + 1),
        `${APP_FOLDER}/${path.slice(0, Math.max(slash, 0))}`,
      );
    });
    sections.push([t.filed.heading(filed.length), ...lines].join("\n"));
  }

  const suspicious = input.suspicious ?? [];
  if (suspicious.length > 0) {
    sections.push([t.suspicious.heading(suspicious.length), ...suspicious.map((s) => t.suspicious.mail(s.subject, s.senderDomain)), t.suspicious.hint].join("\n"));
  }

  const problems = [
    ...input.problems.map((p) => t.problems.mailboxDisconnected(p.emailAddress, settingsUrl)),
    ...(input.filingOffCount ? [t.problems.filingOff(input.filingOffCount, settingsUrl)] : []),
    ...(input.driveQueuedCount ? [t.problems.driveUnreachable(input.driveQueuedCount, settingsUrl)] : []),
    ...(input.refusedForwardCount ? [t.problems.forwardRefused(input.refusedForwardCount, settingsUrl)] : []),
  ];
  if (problems.length > 0) sections.push([t.problems.heading, ...problems].join("\n"));

  const subject = t.subject(input.localDate);
  if (sections.length === 0) return { subject, textBody: `${t.nothingHappened(input.appName)}\n` };
  return { subject, textBody: `${t.greeting}\n\n${sections.join("\n\n")}\n\n${input.appName}\n` };
}

/** Builds and sends one customer's brief for a local date. Sends at most once per date. */
export async function sendBrief(
  deps: Deps,
  job: { customerId: string; localDate: string },
): Promise<"sent" | "already_sent"> {
  const scope = forCustomer(deps.db, job.customerId);
  if (!(await scope.claimBriefForDate(job.localDate))) return "already_sent";

  const runId = await scope.startJobRun("daily-brief", job.localDate);
  try {
    // The follow-up scan normally ran at 06:00. If it has not (worker was down), do it now so the
    // brief can list its results; if it fails, the brief still goes out and the failure is in the job log.
    await chaseCustomer(deps, job).catch(() => undefined);
    await remindCustomer(deps, job).catch(() => undefined);

    const now = deps.now?.() ?? new Date();
    const customer = await scope.getCustomer();
    const today = startOfLocalDay(job.localDate, customer.timeZone);
    const yesterday = startOfLocalDay(addDays(job.localDate, -1), customer.timeZone);
    const [drafts, suspicious, offers, quiet, filed, connections, users, filingOffCount, queuedCount, refusedCount] = await Promise.all([
      scope.listDraftSummaries(yesterday, today),
      scope.listSuspiciousBetween(yesterday, today),
      scope.listOffersBetween(yesterday, today),
      scope.listQuietThreads(today, job.localDate),
      scope.listFiledBetween(yesterday, today),
      scope.listConnections(),
      scope.listUsers(),
      scope.countJobOutcomes("filing", "filing_off", yesterday, today),
      scope.countQueuedFiling(),
      // Every refusal, whatever its reason ("refused_sender:not_listed", "refused_sender:check_not_passed", ...).
      Promise.all(
        ["refused_sender", "refused_sender:not_listed", "refused_sender:check_not_passed", "refused_sender:check_other_domain"].map((outcome) =>
          scope.countJobOutcomes("forwarding-intake", outcome, yesterday, today),
        ),
      ).then((counts) => counts.reduce((sum, n) => sum + n, 0)),
    ]);
    const microsoft = connections.find((c) => c.provider === "microsoft");
    const linkExpiry = new Date(now.getTime() + LINK_DAYS * 86_400_000);
    const link = (threadId: string, action: "skip" | "never") => {
      const token = signLinkToken({ c: job.customerId, t: threadId }, linkExpiry, deps.db.encryptionKey);
      return `${deps.appBaseUrl}/thread?do=${action}&token=${token}`;
    };

    // Money: every open invoice that is overdue or due within a week, with this morning's reminders marked.
    const [openInvoices, invoiceNews] = await Promise.all([
      scope.listOpenInvoices(),
      // An invoice noted more than two hours ago and still not read will not be read any more.
      scope.invoicesForBrief(today, yesterday, new Date(now.getTime() - 2 * 3_600_000)),
    ]);
    const who = (i: { debtorName: string; debtorDomain: string }) => i.debtorName || i.debtorDomain || "your customer";
    const invoiceLink = (invoiceId: string) =>
      `${deps.appBaseUrl}/invoice?token=${signLinkToken({ c: job.customerId, i: invoiceId }, linkExpiry, deps.db.encryptionKey)}`;
    const remindedToday = new Set(invoiceNews.reminded.map((i) => i.id));
    const money: BriefInput["money"] = {
      invoices: openInvoices
        .map((i) => ({ invoice: i, daysOverdue: daysBetween(i.dueDate!, job.localDate) }))
        .filter(({ daysOverdue }) => daysOverdue >= -DUE_SOON_DAYS)
        .map(({ invoice, daysOverdue }) => ({
          number: invoice.number ?? "",
          who: who(invoice),
          amount: invoiceAmount(invoice),
          dueDate: invoice.dueDate!,
          daysOverdue,
          reminder: remindedToday.has(invoice.id)
            ? { level: invoice.remindersMade, inOutlook: invoice.source === "sent" && microsoft?.status === "active" }
            : null,
          waitingLevel: invoice.reminderBlockedOn === job.localDate ? invoice.remindersMade : null,
          manageUrl: invoiceLink(invoice.id),
        })),
      toAsk: invoiceNews.toAsk.map((i) =>
        i.status === "needs_due_date"
          ? { kind: "due_date" as const, number: i.number ?? "", who: who(i), amount: invoiceAmount(i), url: invoiceLink(i.id) }
          : i.status === "needs_confirm"
            ? { kind: "confirm" as const, number: i.number ?? "", who: who(i), amount: invoiceAmount(i), sentTo: i.debtorDomain, url: invoiceLink(i.id) }
            : { kind: "unreadable" as const, fileName: i.fileName },
      ),
      paidBySender: invoiceNews.paidBySender.map((i) => ({ number: i.number ?? "", who: who(i), amount: invoiceAmount(i) })),
    };

    const brief = composeBrief({
      appName: deps.appName,
      appBaseUrl: deps.appBaseUrl,
      localDate: job.localDate,
      drafts,
      suspicious,
      money,
      offers: offers.map((o) => ({
        kind: o.kind,
        number: o.number,
        recipientDomain: o.recipientDomain,
        grossTotal: formatMoney(o.grossCents, o.currency, "en"),
        confirmUrl:
          o.kind === "offer" && o.status === "prepared" && allowed(deps, customer).offers
            ? `${deps.appBaseUrl}/offer?token=${signLinkToken({ c: job.customerId, o: o.id }, linkExpiry, deps.db.encryptionKey)}`
            : null,
      })),
      quiet: quiet.map((q) => ({
        ...q,
        workingDaysQuiet: workingDaysBetween(q.lastOutboundAt, now, customer.timeZone),
        skipUrl: link(q.threadId, "skip"),
        neverUrl: link(q.threadId, "never"),
      })),
      filed,
      problems: connections.filter((c) => c.status === "needs_reconnect" || c.status === "revoked"),
      // Asked only on days it mattered, and only while the mailbox still lacks the permission.
      filingOffCount: microsoft && microsoft.status === "active" && !canFile(microsoft) ? filingOffCount : 0,
      driveQueuedCount: microsoft?.driveError ? queuedCount : 0,
      refusedForwardCount: refusedCount,
    });
    await deps.mailer.send({ to: users.map((u) => u.email), ...brief });
    // Only now are the one-time questions counted as asked.
    await scope.markInvoicesListed(invoiceNews.toAsk.map((i) => i.id), job.localDate);
    await scope.finishJobRun(runId, { status: "succeeded" });
    return "sent";
  } catch (error) {
    await scope.releaseBriefForDate(job.localDate);
    await scope.finishJobRun(runId, { status: "failed", error: describeError(error) });
    throw error;
  }
}
