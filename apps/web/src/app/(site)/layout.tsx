import type { ReactNode } from "react";
import { getConfig } from "@/lib/server";
import { contactEmail, signInUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

/** Header and footer of the public site. */
export default function SiteLayout({ children }: { children: ReactNode }) {
  const { appName } = getConfig();
  const signIn = signInUrl();
  const email = contactEmail();
  return (
    <div className="bg-white">
      <header className="border-b border-stone-200">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <a href="/" className="text-lg font-semibold tracking-tight text-teal-800">
            {appName}
          </a>
          <nav className="flex items-center gap-5 text-sm">
            <a href="/#what" className="hidden text-stone-700 hover:text-stone-900 sm:inline">
              What it does
            </a>
            <a href="/#plans" className="hidden text-stone-700 hover:text-stone-900 sm:inline">
              Plans
            </a>
            <a href="/#questions" className="hidden text-stone-700 hover:text-stone-900 sm:inline">
              Questions
            </a>
            <a href={signIn} className="text-stone-700 hover:text-stone-900">
              Sign in
            </a>
            <a href={signIn} className="btn">
              Start free
            </a>
          </nav>
        </div>
      </header>

      {children}

      <footer className="border-t border-stone-200 bg-stone-50">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-8 text-sm text-stone-600 sm:flex-row sm:items-center sm:justify-between">
          <p>
            {appName}. Your back office, handled.
          </p>
          <nav className="flex flex-wrap gap-5">
            <a className="hover:text-stone-900" href="/privacy">
              Privacy
            </a>
            <a className="hover:text-stone-900" href="/terms">
              Terms
            </a>
            <a className="hover:text-stone-900" href={`mailto:${email}`}>
              {email}
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
