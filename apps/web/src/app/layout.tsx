import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const appName = process.env.APP_NAME || "Adminwise";

export const metadata: Metadata = {
  title: { default: `${appName}: your back office, handled`, template: `%s | ${appName}` },
  description:
    "Offers, payment reminders, follow-ups, filing and a daily overview, prepared for you straight from your inbox. You check and send; nothing is sent for you.",
};

/** Two areas share this shell: the public site in (site) and the signed-in app in (app). */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
