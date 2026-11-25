import { redirect } from "next/navigation";
import { getSession, landingPath, normalizeEmail, rememberNext, safeNext, sendSignInLink } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function requestLink(formData: FormData) {
  "use server";
  const email = normalizeEmail(formData.get("email"));
  if (!email) redirect("/signin?error=email");
  // Came here from a link in the brief: go back to it after signing in.
  await rememberNext(safeNext(formData.get("next")));
  await sendSignInLink(email);
  redirect("/signin?sent=1");
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string; closed?: string; next?: string }>;
}) {
  const session = await getSession();
  const params = await searchParams;
  const next = safeNext(params.next);
  if (session) redirect(next ?? (await landingPath(session)));

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-1 text-stone-600">Your back office, handled.</p>

      {params.closed && (
        <p className="mt-6 rounded-md border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900">
          Your account is closed and its data has been deleted.
        </p>
      )}
      <div className="card mt-8">
        {params.sent ? (
          <p>
            Check your inbox: we sent you an email. If this address has an account, it holds your sign-in link, which
            works once and expires in 15 minutes.
          </p>
        ) : (
          <form action={requestLink} className="space-y-4">
            {next && (
              <>
                <input type="hidden" name="next" value={next} />
                <p className="rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900">
                  Sign in to continue. This link from your daily brief changes an invoice or an offer, so we check that
                  it is you. After signing in you are taken straight back to it.
                </p>
              </>
            )}
            <div>
              <label htmlFor="email">Work email</label>
              <input id="email" name="email" type="email" required autoComplete="email" placeholder="you@company.com" />
              {params.error === "email" && <p className="mt-1 text-sm text-red-700">Enter a valid email address.</p>}
              {params.error === "link" && (
                <p className="mt-1 text-sm text-red-700">That link was already used or has expired. Ask for a new one.</p>
              )}
            </div>
            <button className="btn" type="submit">
              Email me a sign-in link
            </button>
            <p className="hint">
              No password. New here?{" "}
              <a className="underline" href="/request">
                Request access
              </a>{" "}
              first.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
