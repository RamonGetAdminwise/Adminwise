import { QUEUES } from "@adminwise/core";
import { forCustomer, verifyLinkToken } from "@adminwise/db";
import { formatMoney } from "@adminwise/offers";
import { redirect } from "next/navigation";
import { ownerOfLink } from "@/lib/auth";
import { getConfig, getDb, getQueue } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Which customer's offer a link from the daily brief is about; null when it was changed or has expired. */
function readToken(token: unknown): { customerId: string; offerId: string } | null {
  if (typeof token !== "string") return null;
  const payload = verifyLinkToken(token, getDb().encryptionKey);
  return payload?.c && payload.o ? { customerId: payload.c, offerId: payload.o } : null;
}

async function confirm(formData: FormData) {
  "use server";
  const target = readToken(formData.get("token"));
  if (!target) redirect("/offer?done=invalid");
  // An order confirmation is a commitment: only for someone signed in to this account.
  if ((await ownerOfLink(target.customerId, `/offer?token=${String(formData.get("token"))}`)) !== "ok") redirect("/offer?done=other");
  const scope = forCustomer(getDb(), target.customerId);
  const offer = await scope.getOffer(target.offerId);
  if (!offer || offer.kind !== "offer") redirect("/offer?done=invalid");
  if (offer.status === "accepted") redirect("/offer?done=already");

  // The worker makes the document and the draft; this only asks for it.
  await (await getQueue()).send(QUEUES.confirmOffer, { customerId: target.customerId, offerId: offer.id });
  await scope.audit("offer.confirmed_by_owner", { offerId: offer.id });
  redirect("/offer?done=confirmed");
}

const DONE: Record<string, string> = {
  confirmed:
    "Done. The order confirmation is being prepared. In a minute it is in your Outlook Drafts, attached to a reply on the original request (or in your inbox if you use the forwarding address). Nothing is sent for you.",
  already: "This offer already has its order confirmation.",
  other: "This link belongs to another account than the one you are signed in to. Sign out and use the address this brief was sent to.",
  invalid: "This link is no longer valid. Links in the daily brief work for 30 days.",
};

/**
 * "Prepare the order confirmation" from the daily brief lands here, for an
 * offer the customer accepted by phone or in another way. Nothing happens
 * until the button is pressed, so a mail scanner opening the link changes nothing.
 */
export default async function OfferPage({ searchParams }: { searchParams: Promise<{ token?: string; done?: string }> }) {
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
  if (!target) redirect("/offer?done=invalid");
  if ((await ownerOfLink(target.customerId, `/offer?token=${params.token}`)) !== "ok") redirect("/offer?done=other");
  const offer = await forCustomer(getDb(), target.customerId).getOffer(target.offerId);
  if (!offer || offer.kind !== "offer") redirect("/offer?done=invalid");
  if (offer.status === "accepted") redirect("/offer?done=already");

  return (
    <div className="card mx-auto max-w-md">
      <h1 className="text-xl font-semibold">Order confirmation</h1>
      <p className="mt-3 text-sm text-stone-600">Offer</p>
      <p className="text-sm font-medium">
        {offer.number} for {offer.recipientDomain}
      </p>
      <p className="text-sm">
        {offer.lines.length} item(s), {formatMoney(offer.grossCents, offer.currency, "en")} including VAT
      </p>
      <p className="mt-4 text-sm">
        Has the customer accepted this offer? {appName} then prepares the order confirmation with the same items and
        prices, and a draft email to go with it.
      </p>
      <p className="hint">The document says it is not a VAT invoice. Nothing is sent for you.</p>
      <form action={confirm} className="mt-4">
        <input type="hidden" name="token" value={params.token} />
        <button className="btn" type="submit">
          Prepare the order confirmation
        </button>
      </form>
    </div>
  );
}
