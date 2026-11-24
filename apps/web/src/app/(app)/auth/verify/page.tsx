import { redirect } from "next/navigation";
import { completeSignIn, getSession, landingPath, signInLinkOwner } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function signIn(formData: FormData) {
  "use server";
  const token = formData.get("token");
  const ok = typeof token === "string" && (await completeSignIn(token));
  if (!ok) redirect("/signin?error=link");
  const session = await getSession();
  redirect(session ? await landingPath(session) : "/settings");
}

/**
 * The link from the email lands here. Signing in needs one click on the
 * button: mail scanners that open links automatically cannot use up the link.
 */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) redirect("/signin");
  const email = await signInLinkOwner(token);
  if (!email) redirect("/signin?error=link");
  return (
    <div className="card mx-auto max-w-md">
      <h1 className="text-xl font-semibold">Almost there</h1>
      <p className="mt-2 text-sm text-stone-700">
        You are signing in to the account of <strong>{email}</strong>.
      </p>
      <p className="hint">
        Not your address? Then someone sent you their link: close this page. Anything you connect after signing in
        would belong to their account.
      </p>
      <form action={signIn} className="mt-4">
        <input type="hidden" name="token" value={token} />
        <button className="btn" type="submit">
          Sign in
        </button>
      </form>
    </div>
  );
}
