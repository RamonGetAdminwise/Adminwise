import { redirect } from "next/navigation";
import { completeSignIn } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function signIn(formData: FormData) {
  "use server";
  const token = formData.get("token");
  const ok = typeof token === "string" && (await completeSignIn(token));
  redirect(ok ? "/settings" : "/?error=link");
}

/**
 * The link from the email lands here. Signing in needs one click on the
 * button: mail scanners that open links automatically cannot use up the link.
 */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) redirect("/");
  return (
    <div className="card mx-auto max-w-md">
      <h1 className="text-xl font-semibold">Almost there</h1>
      <form action={signIn} className="mt-4">
        <input type="hidden" name="token" value={token} />
        <button className="btn" type="submit">
          Sign in
        </button>
      </form>
    </div>
  );
}
