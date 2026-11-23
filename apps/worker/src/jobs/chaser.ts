import { checkExpectsReply, draftChaser } from "@adminwise/ai";
import { ConnectionUnavailableError, isWeekend, localClock, QUEUES, workingDaysBetween } from "@adminwise/core";
import { forCustomer, system } from "@adminwise/db";
import { domainOf, GraphAuthError, GraphError } from "@adminwise/mail";
import { describeError, type Deps } from "../deps";
import { ownDomains, SYSTEM_SENDER } from "./prefilter";
import { appendSignature } from "./signature";

/** 06:00 in the customer's own time zone: follow-ups are ready before the 07:30 brief. */
export const CHASE_MINUTE_OF_DAY = 6 * 60;
/** After two unanswered follow-ups a thread is only listed in the brief. */
export const MAX_CHASERS = 2;
/** Threads silent for longer than this are left alone. */
const MAX_THREAD_AGE_DAYS = 60;

export interface ChaseResult {
  status: "done" | "already_ran" | "weekend" | "no_mailbox";
  /** Follow-up drafts written in this run. */
  chasers: number;
  /** Threads listed as "went quiet" because two follow-ups were already used. */
  listed: number;
}

/** Runs every minute. Queues the nightly scan for each customer whose local clock has reached 06:00. */
export async function chaseTick(deps: Deps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  let queued = 0;
  for (const customer of await system(deps.db).listCustomerClocks()) {
    const clock = localClock(now, customer.timeZone);
    if (clock.minutesOfDay < CHASE_MINUTE_OF_DAY) continue;
    // The payment reminders run at the same hour, with their own once-a-day marker.
    if (!customer.remindLastRunOn || customer.remindLastRunOn < clock.date) {
      await deps.queue.send(QUEUES.remindCustomer, { customerId: customer.id, localDate: clock.date });
    }
    if (customer.chaseLastRunOn && customer.chaseLastRunOn >= clock.date) continue;
    await deps.queue.send(QUEUES.chaseCustomer, { customerId: customer.id, localDate: clock.date });
    queued++;
  }
  return queued;
}

/**
 * The follow-up chaser for one customer, once per customer-local date.
 *
 * A thread gets a follow-up draft when all of this is true:
 *   - the customer wrote last (an automatic reply from the other side does not count),
 *   - the follow-up period has passed, in working days, since that message, the
 *     last follow-up or the customer's "not this time",
 *   - the customer has not said "never" for the thread,
 *   - fewer than two follow-ups were written since the other party last answered,
 *   - no follow-up draft is still waiting unsent in the thread,
 *   - the message went to a person outside the company (not a no-reply address),
 *   - the customer's message expects an answer (the model is asked once per message).
 *
 * The draft is a reply in the same thread, in the Drafts folder. Nothing is sent.
 * A draft the customer deleted counts as "not this time".
 */
export async function chaseCustomer(deps: Deps, job: { customerId: string; localDate: string }): Promise<ChaseResult> {
  const scope = forCustomer(deps.db, job.customerId);
  if (!(await scope.claimChaseForDate(job.localDate))) return { status: "already_ran", chasers: 0, listed: 0 };
  // Follow-ups are for working days; Monday's run picks up what came due over the weekend.
  if (isWeekend(job.localDate)) return { status: "weekend", chasers: 0, listed: 0 };

  const now = deps.now?.() ?? new Date();
  const runId = await scope.startJobRun("chaser", job.localDate);
  let inputTokens = 0;
  let outputTokens = 0;
  let chasers = 0;
  let listed = 0;
  let firstFailure: unknown = null;

  try {
    const connection = await scope.getConnectionByProvider("microsoft");
    if (!connection || connection.status !== "active") {
      await scope.finishJobRun(runId, { status: "succeeded", outcome: "no_mailbox" });
      return { status: "no_mailbox", chasers: 0, listed: 0 };
    }
    const [customer, users, connections] = await Promise.all([
      scope.getCustomer(),
      scope.listUsers(),
      scope.listConnections(),
    ]);
    const internal = ownDomains([...users.map((u) => u.email), ...connections.map((c) => c.emailAddress)]);

    // 1. Follow-up drafts from earlier runs: still waiting, or gone (sent or deleted)?
    const waiting = new Set<string>();
    for (const draft of await scope.listOpenChasers()) {
      if (draft.providerDraftId && (await deps.outlook.isDraftWaiting(scope, connection.id, draft.providerDraftId))) {
        waiting.add(draft.threadId);
        continue;
      }
      await scope.closeDraft(draft.id);
      const thread = await scope.getThread(draft.threadId);
      const sentIt = thread?.lastOutboundAt && draft.completedAt && thread.lastOutboundAt > draft.completedAt;
      // Deleted without sending = "not this time": ask again after another follow-up period.
      if (thread && !sentIt) await scope.snoozeChase(thread.id, now);
    }

    // 2. Threads where the customer wrote last.
    const oldest = new Date(now.getTime() - MAX_THREAD_AGE_DAYS * 86_400_000);
    for (const thread of await scope.listChaseCandidates(oldest)) {
      if (waiting.has(thread.id)) continue;
      const reference =
        thread.chaseHoldFrom && thread.chaseHoldFrom > thread.lastOutboundAt ? thread.chaseHoldFrom : thread.lastOutboundAt;
      if (workingDaysBetween(reference, now, customer.timeZone) < customer.followUpDays) continue;

      const alreadyJudged = thread.expectsReplyFor === thread.messageId;
      if (alreadyJudged && thread.expectsReply === false) continue;

      if (thread.chaserCount >= MAX_CHASERS) {
        await scope.markWentQuiet(thread.id, job.localDate);
        listed++;
        continue;
      }

      try {
        // The customer's own message is read from the mailbox again: its text was removed here after 24 hours.
        let sent;
        try {
          sent = await deps.outlook.fetchMessage(scope, thread.connectionId, thread.providerMessageId);
        } catch (error) {
          if (!(error instanceof GraphError && error.status === 404)) throw error;
          // The message is no longer in the mailbox: nothing to follow up on.
          await scope.setChaseVerdict(thread.id, thread.messageId, false);
          continue;
        }
        const to = (sent.to ?? []).filter((a) => !SYSTEM_SENDER.test(a) && !internal.has(domainOf(a)));
        if (to.length === 0) {
          // Only colleagues or no-reply addresses: never follow up on this message.
          await scope.setChaseVerdict(thread.id, thread.messageId, false);
          continue;
        }

        if (!alreadyJudged) {
          const check = await checkExpectsReply(deps.ai, {
            companyName: customer.name,
            subject: sent.subject,
            body: sent.bodyText,
          });
          inputTokens += check.usage.inputTokens;
          outputTokens += check.usage.outputTokens;
          await scope.setChaseVerdict(thread.id, thread.messageId, check.expectsReply);
          if (!check.expectsReply) continue;
        }

        const chaserNumber = thread.chaserCount + 1;
        const draftId = await scope.claimDraft({
          messageId: thread.messageId,
          threadId: thread.id,
          destination: "outlook_drafts",
          language: null,
          languageListed: true,
          kind: "chaser",
          seq: chaserNumber,
        });
        if (!draftId) continue;
        try {
          const draft = await draftChaser(deps.ai, {
            companyName: customer.name,
            voiceProfile: customer.voiceProfile,
            subject: sent.subject,
            body: sent.bodyText,
            workingDaysQuiet: workingDaysBetween(thread.lastOutboundAt, now, customer.timeZone),
            chaserNumber,
          });
          inputTokens += draft.usage.inputTokens;
          outputTokens += draft.usage.outputTokens;
          const text = appendSignature(draft.body, customer.signatureText);
          const cc = (sent.cc ?? []).filter((a) => !SYSTEM_SENDER.test(a));
          const providerDraftId = await deps.outlook.createChaserDraft(
            scope,
            thread.connectionId,
            thread.providerMessageId,
            text,
            to,
            cc,
          );
          await scope.completeDraft(draftId, text, providerDraftId, now);
          await scope.recordChaser(thread.id, now);
          chasers++;
        } catch (error) {
          await scope.failDraft(draftId, describeError(error));
          throw error;
        }
      } catch (error) {
        // The mailbox itself is unusable: stop, the brief shows the reconnect link.
        if (error instanceof ConnectionUnavailableError || error instanceof GraphAuthError) throw error;
        // One thread failing must not keep the others from getting their follow-up.
        firstFailure ??= error;
      }
    }

    if (firstFailure) throw firstFailure;
    await scope.finishJobRun(runId, {
      status: "succeeded",
      inputTokens,
      outputTokens,
      outcome: `chasers:${chasers},listed:${listed}`,
    });
    return { status: "done", chasers, listed };
  } catch (error) {
    if (error instanceof ConnectionUnavailableError || error instanceof GraphAuthError) {
      await scope.finishJobRun(runId, { status: "skipped", inputTokens, outputTokens, error: describeError(error) });
      return { status: "no_mailbox", chasers, listed };
    }
    // Let the queue try again later today; threads that already got their draft are skipped then.
    await scope.releaseChaseForDate(job.localDate);
    await scope.finishJobRun(runId, { status: "failed", inputTokens, outputTokens, error: describeError(error) });
    throw error;
  }
}
