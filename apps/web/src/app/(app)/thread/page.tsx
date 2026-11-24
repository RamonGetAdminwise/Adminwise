import { forCustomer, verifyLinkToken } from "@adminwise/db";
import { redirect } from "next/navigation";
import { getConfig, getDb, getOutlook } from "@/lib/server";

export const dynamic = "force-dynamic";

type Action = "skip" | "never";
const isAction = (value: unknown): value is Action => value === "skip" || value === "never";

/** Who and which thread a link from the daily brief is about; null when it was changed or has expired. */
function readToken(token: unknown): { customerId: string; threadId: string } | null {
  if (typeof token !== "string") return null;
  const payload = verifyLinkToken(token, getDb().encryptionKey);
  return payload?.c && payload.t ? { customerId: payload.c, threadId: payload.t } : null;
}

async function apply(formData: FormData) {
  "use server";
  const target = readToken(formData.get("token"));
  const action = formData.get("action");
  if (!target || !isAction(action)) redirect("/thread?done=invalid");

  const scope = forCustomer(getDb(), target.customerId);
  const thread = await scope.getThread(target.threadId);
  if (!thread) redirect("/thread?done=invalid");

  // The follow-up draft that was waiting is no longer wanted: take it out of the Drafts folder.
  const waiting = await scope.getOpenChaser(thread.id);
  if (action === "never") await scope.setChaseMode(thread.id, "never");
  // A draft that is skipped was never sent, so it does not count as one of the two follow-ups.
  else await scope.snoozeChase(thread.id, new Date(), Boolean(waiting));

  if (waiting) {
    await scope.closeDraft(waiting.id);
    const connection = await scope.getConnectionByProvider("microsoft");
    const outlook = getOutlook();
    if (waiting.providerDraftId && connection && outlook) {
      // If the mailbox cannot be reached the choice still stands; the draft is then simply left where it is.
      await outlook.deleteDraft(scope, connection.id, waiting.providerDraftId).catch(() => undefined);
    }
  }
  await scope.audit(action === "never" ? "chaser.never_for_thread" : "chaser.not_this_time", { threadId: thread.id });
  redirect(`/thread?done=${action}`);
}

const DONE: Record<string, string> = {
  skip: "Done. No follow-up for this conversation this time. If it stays quiet, a new follow-up draft is prepared after your follow-up period.",
  never: "Done. No follow-ups will be prepared for this conversation again.",
  invalid: "This link is no longer valid. Links in the daily brief work for 30 days; use the one in a newer brief.",
};

/**
 * The "Not this time" and "Never for this thread" links in the daily brief
 * land here. Nothing changes until the button is pressed, so mail scanners
 * that open links automatically cannot switch follow-ups off.
 */
export default async function ThreadPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; do?: string; done?: string }>;
}) {
  const params = await searchParams;
  const appName = getConfig().appName;

  if (params.done) {
    return (
      <div className="card mx-auto max-w-md">
        <h1 className="text-xl font-semibold">{appName}</h1>
        <p className="mt-3 text-sm">{DONE[params.done] ?? DONE.invalid}</p>
      </div>
    );
  }

  const target = readToken(params.token);
  const thread = target ? await forCustomer(getDb(), target.customerId).getThread(target.threadId) : null;
  if (!target || !thread || !isAction(params.do)) redirect("/thread?done=invalid");

  return (
    <div className="card mx-auto max-w-md">
      <h1 className="text-xl font-semibold">Follow-up for this conversation</h1>
      <p className="mt-3 text-sm text-stone-600">Conversation</p>
      <p className="text-sm font-medium">{thread.subject || "(no subject)"}</p>
      <p className="mt-4 text-sm">
        {params.do === "never"
          ? "Stop preparing follow-ups for this conversation for good?"
          : "Skip the follow-up this time? If the conversation stays quiet, a new one is prepared after your follow-up period."}
      </p>
      <p className="hint">The follow-up draft waiting in your Outlook Drafts is removed. Nothing is sent.</p>
      <form action={apply} className="mt-4">
        <input type="hidden" name="token" value={params.token} />
        <input type="hidden" name="action" value={params.do} />
        <button className="btn" type="submit">
          {params.do === "never" ? "Never for this thread" : "Not this time"}
        </button>
      </form>
    </div>
  );
}
