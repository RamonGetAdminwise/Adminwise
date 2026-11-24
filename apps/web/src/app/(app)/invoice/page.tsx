import { forCustomer, verifyLinkToken } from "@adminwise/db";
import { formatMoney } from "@adminwise/offers";
import { redirect } from "next/navigation";
import { getConfig, getDb, getOutlook } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Which customer's invoice a link from the daily brief is about; null when it was changed or has expired. */
function readToken(token: unknown): { customerId: string; invoiceId: string } | null {
  if (typeof token !== "string") return null;
  const payload = verifyLinkToken(token, getDb().encryptionKey);
  return payload?.c && payload.i ? { customerId: payload.c, invoiceId: payload.i } : null;
}

const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

async function act(formData: FormData) {
  "use server";
  const target = readToken(formData.get("token"));
  const action = formData.get("action");
  if (!target) redirect("/invoice?done=invalid");
  const scope = forCustomer(getDb(), target.customerId);
  const invoice = await scope.getInvoice(target.invoiceId);
  if (!invoice) redirect("/invoice?done=invalid");

  if (action === "due") {
    const dueDate = String(formData.get("dueDate") ?? "");
    if (!isIsoDate(dueDate)) redirect(`/invoice?token=${encodeURIComponent(String(formData.get("token")))}&error=date`);
    const ok = await scope.setInvoiceDueDate(invoice.id, dueDate);
    if (ok) await scope.audit("invoice.due_date_set", { invoiceId: invoice.id });
    redirect(`/invoice?done=${ok ? "due" : "closed"}`);
  }

  if (action === "paid" || action === "stopped") {
    const ended = await scope.endInvoice(invoice.id, action, "owner", new Date());
    if (ended) {
      // A reminder draft that is still waiting is no longer wanted: take it out of the Drafts folder.
      const waiting = await scope.getOpenReminder(invoice.id);
      if (waiting) {
        await scope.closeDraft(waiting.id);
        const outlook = getOutlook();
        if (waiting.providerDraftId && invoice.connectionId && outlook) {
          await outlook.deleteDraft(scope, invoice.connectionId, waiting.providerDraftId).catch(() => undefined);
        }
      }
    }
    if (ended) await scope.audit(action === "paid" ? "invoice.marked_paid" : "invoice.reminders_stopped", { invoiceId: invoice.id });
    redirect(`/invoice?done=${ended ? action : "closed"}`);
  }
  redirect("/invoice?done=invalid");
}

const DONE: Record<string, string> = {
  paid: "Done. The invoice is marked as paid and no more reminders will be prepared for it.",
  stopped: "Done. No more reminders will be prepared for this invoice.",
  due: "Done. The due date is set. Reminders are prepared 7, 14 and 30 days after it, as drafts for you to send.",
  closed: "Nothing to do: this invoice was already marked as paid or stopped.",
  invalid: "This link is no longer valid. Links in the daily brief work for 30 days; use the one in a newer brief.",
};

/**
 * The invoice links in the daily brief land here: mark an invoice as paid,
 * stop its reminders, or supply a due date that could not be read. Nothing
 * changes until a button is pressed, so a mail scanner opening the link does nothing.
 */
export default async function InvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; done?: string; error?: string }>;
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
  const invoice = target ? await forCustomer(getDb(), target.customerId).getInvoice(target.invoiceId) : null;
  if (!target || !invoice) redirect("/invoice?done=invalid");
  if (invoice.status !== "open" && invoice.status !== "needs_due_date") redirect("/invoice?done=closed");

  const who = invoice.debtorName || invoice.debtorDomain || "your customer";
  const amount = invoice.amountCents === null ? "" : formatMoney(invoice.amountCents, invoice.currency ?? "", "en");

  return (
    <div className="card mx-auto max-w-md">
      <h1 className="text-xl font-semibold">Invoice {invoice.number}</h1>
      <p className="mt-2 text-sm">
        To {who}
        {amount && `, ${amount}`}
        {invoice.dueDate ? `, due ${invoice.dueDate}` : ", no due date known"}
      </p>
      {params.error === "date" && <p className="mt-3 text-sm text-red-700">Choose a date.</p>}

      {invoice.status === "needs_due_date" && (
        <form action={act} className="mt-5 space-y-3">
          <input type="hidden" name="token" value={params.token} />
          <input type="hidden" name="action" value="due" />
          <div>
            <label htmlFor="dueDate">Due date</label>
            <input id="dueDate" name="dueDate" type="date" required className="mt-1 block rounded-md border border-stone-300 px-3 py-2 text-sm" />
            <p className="hint">The due date could not be read from the invoice. Reminders are prepared 7, 14 and 30 days after it.</p>
          </div>
          <button className="btn" type="submit">
            Set due date
          </button>
        </form>
      )}

      <div className="mt-6 flex flex-wrap gap-3 border-t border-stone-200 pt-5">
        <form action={act}>
          <input type="hidden" name="token" value={params.token} />
          <input type="hidden" name="action" value="paid" />
          <button className="btn" type="submit">
            It has been paid
          </button>
        </form>
        <form action={act}>
          <input type="hidden" name="token" value={params.token} />
          <input type="hidden" name="action" value="stopped" />
          <button className="btn-secondary" type="submit">
            Stop reminders for this invoice
          </button>
        </form>
      </div>
      <p className="hint">A reminder draft still waiting in your Outlook Drafts is removed. Nothing is sent for you.</p>
    </div>
  );
}
