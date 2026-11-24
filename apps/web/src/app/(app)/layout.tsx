import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";

/** The signed-in app and its confirm pages: nothing here is for search engines. */
export const metadata: Metadata = {
  title: { absolute: process.env.APP_NAME || "Adminwise" },
  robots: { index: false, follow: false },
};

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center px-4 py-3">
          <a href="/" aria-label="Adminwise home">
            <Logo size={26} />
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">{children}</main>
    </>
  );
}
