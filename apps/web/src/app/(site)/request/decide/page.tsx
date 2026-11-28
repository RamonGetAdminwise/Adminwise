import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { decideRequest, MAIL_SYSTEMS, requestOfLink } from "@/lib/access";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Decide on a request", robots: { index: false } };

/**
 * The page behind the link in the "request for access" mail. Opening it changes nothing (mail
 * programs open links by themselves to check them); only the buttons do. The signed link is the
 * key: it is mailed to the owner of the service only.
 */
async function decide(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const decision = formData.get("decision") === "approved" ? "approved" : "declined";
  const result = await decideRequest(token, decision);
  redirect(`/request/decide?token=${encodeURIComponent(token)}${result && !result.told ? "&mail=failed" : ""}`);
}

export default async function DecidePage({ searchParams }: { searchParams: Promise<{ token?: string; mail?: string }> }) {
  const { token = "", mail } = await searchParams;
  const request = token ? await requestOfLink(token) : null;

  if (!request) {
    return (
      <div className="mx-auto max-w-xl px-4 py-14">
        <h1 className="text-2xl font-semibold">This link no longer works</h1>
        <p className="mt-3 text-stone-700">It is too old, or the request it belongs to has been removed.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-14">
      <h1 className="text-2xl font-semibold">Request for access</h1>
      <div className="card mt-6">
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-stone-500">Company</dt>
          <dd className="font-medium">{request.company}</dd>
          <dt className="text-stone-500">Name</dt>
          <dd>{request.contactName}</dd>
          <dt className="text-stone-500">Email</dt>
          <dd>{request.email}</dd>
          <dt className="text-stone-500">Mail system</dt>
          <dd>{MAIL_SYSTEMS[request.mailSystem]}</dd>
          <dt className="text-stone-500">Received</dt>
          <dd>{request.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC</dd>
        </dl>
        <p className="mt-4 text-sm text-stone-500">What they want help with</p>
        <p className="mt-1 whitespace-pre-wrap text-sm">{request.note ?? "(nothing written)"}</p>

        {request.status === "pending" ? (
          <form action={decide} className="mt-6 flex flex-wrap gap-3">
            <input type="hidden" name="token" value={token} />
            <button className="btn" type="submit" name="decision" value="approved">
              Approve
            </button>
            <button className="btn-secondary" type="submit" name="decision" value="declined">
              Decline
            </button>
          </form>
        ) : (
          <p className="mt-6 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900">
            {request.status === "approved"
              ? mail === "failed"
                ? "Approved."
                : "Approved. They were sent a welcome email that explains how to sign in."
              : mail === "failed"
                ? "Declined."
                : "Declined. They were told by email."}
          </p>
        )}
        {request.status !== "pending" && mail === "failed" && (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            The email to {request.email} could not be sent. The decision stands, but they do not know it yet: write to
            them yourself. The reason is in a separate email to you.
          </p>
        )}
        {request.status === "pending" && (
          <p className="hint mt-3">
            Approve: they get a welcome email and can sign in. Decline: they get a short, polite no. Either way they
            hear from us right away.
          </p>
        )}
      </div>
    </div>
  );
}
