import { redirect } from "next/navigation";
import { getSession, landingPath, normalizeEmail, sendSignInLink } from "@/lib/auth";
import { getConfig } from "@/lib/server";

export const dynamic = "force-dynamic";

async function requestLink(formData: FormData) {
  "use server";
  const email = normalizeEmail(formData.get("email"));
  if (!email) redirect("/?error=email");
  await sendSignInLink(email);
  redirect("/?sent=1");
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const session = await getSession();
  if (session) redirect(await landingPath(session));
  const params = await searchParams;
  const { appName } = getConfig();

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-semibold">{appName}</h1>
      <p className="mt-1 text-stone-600">Your back office, handled.</p>

      <div className="card mt-8">
        {params.sent ? (
          <p>
            Check your inbox: we sent you a sign-in link. It works once and expires in 15 minutes.
          </p>
        ) : (
          <form action={requestLink} className="space-y-4">
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
            <p className="hint">No password. New here? The same link creates your account.</p>
          </form>
        )}
      </div>
    </div>
  );
}
