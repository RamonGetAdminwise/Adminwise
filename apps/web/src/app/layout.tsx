import type { Metadata } from "next";
import { Inter, Plus_Jakarta_Sans } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const appName = process.env.APP_NAME || "Adminwise";

// The two typefaces of the house style. They are downloaded when the app is built and served
// from our own address, so no visitor's browser calls Google.
const inter = Inter({ subsets: ["latin", "latin-ext"], variable: "--font-inter", display: "swap" });
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin", "latin-ext"], variable: "--font-jakarta", display: "swap", weight: ["500", "600", "700", "800"] });

export const metadata: Metadata = {
  title: { default: `${appName}: your back office, handled`, template: `%s | ${appName}` },
  description:
    "Offers, payment reminders, follow-ups, filing and a daily overview, prepared for you straight from your inbox. You check and send; nothing is sent for you.",
};

/** Two areas share this shell: the public site in (site) and the signed-in app in (app). */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jakarta.variable}`}>
      <body>{children}</body>
    </html>
  );
}
