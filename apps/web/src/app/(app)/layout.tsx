import type { Metadata } from "next";
import type { ReactNode } from "react";

/** The signed-in app and its confirm pages: nothing here is for search engines. */
export const metadata: Metadata = {
  title: { absolute: process.env.APP_NAME || "Adminwise" },
  robots: { index: false, follow: false },
};

export default function AppLayout({ children }: { children: ReactNode }) {
  return <main className="mx-auto max-w-3xl px-4 py-10">{children}</main>;
}
