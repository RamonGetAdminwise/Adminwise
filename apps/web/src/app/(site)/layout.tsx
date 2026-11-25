import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { contactEmail, signInUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

/** Header and footer of the public site. */
export default function SiteLayout({ children }: { children: ReactNode }) {
  const signIn = signInUrl();
  const email = contactEmail();
  return (
    <div className="bg-white">
      <header className="sticky top-0 z-20 border-b border-stone-200/70 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <a href="/" aria-label="Adminwise home">
            <Logo size={30} />
          </a>
          <nav className="flex items-center gap-1 text-sm font-medium sm:gap-2">
            {[
              ["/#what", "What it does"],
              ["/#how", "How it starts"],
              ["/#plans", "Plans"],
              ["/#questions", "Questions"],
            ].map(([href, label]) => (
              <a key={href} href={href} className="hidden rounded-lg px-3 py-2 text-stone-700 hover:bg-stone-100 hover:text-ink md:inline">
                {label}
              </a>
            ))}
            <a href={signIn} className="rounded-lg px-3 py-2 text-stone-700 hover:bg-stone-100 hover:text-ink">
              Sign in
            </a>
            <a href="/request" className="btn">
              Request access
            </a>
          </nav>
        </div>
      </header>

      {children}

      <footer className="bg-brand-950 text-brand-100">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-[1.5fr_1fr_1fr]">
          <div>
            <Logo size={28} tone="light" />
            <p className="mt-3 max-w-xs text-sm text-brand-200">Your back office, handled. Prepared for you, sent by you.</p>
          </div>
          <nav className="flex flex-col gap-2 text-sm">
            <p className="font-semibold text-white">Product</p>
            <a className="hover:text-white" href="/#what">What it does</a>
            <a className="hover:text-white" href="/#plans">Plans</a>
            <a className="hover:text-white" href={signIn}>Sign in</a>
          </nav>
          <nav className="flex flex-col gap-2 text-sm">
            <p className="font-semibold text-white">Company</p>
            <a className="hover:text-white" href="/privacy">Privacy</a>
            <a className="hover:text-white" href="/terms">Terms</a>
            <a className="hover:text-white" href={`mailto:${email}`}>{email}</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
