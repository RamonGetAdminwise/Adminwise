import path from "node:path";
import type { NextConfig } from "next";

// One .env at the repository root serves web and worker in local development.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch {
  // no .env file: real environment variables are used (Docker, Railway)
}

const config: NextConfig = {
  // Our own packages are TypeScript source; Next compiles them with the app.
  transpilePackages: ["@adminwise/db", "@adminwise/core", "@adminwise/mail", "@adminwise/ai", "@adminwise/offers"],
  serverExternalPackages: ["pg", "pg-boss", "exceljs", "unpdf"],
  // Price lists (up to 5 MB) and logos are uploaded through forms.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  // Next would otherwise write an AGENTS.md file into this folder on every start.
  agentRules: false,
  // Links in our emails carry a signed token in the address: never pass the address on to another
  // site. No page of ours may be shown inside another site's frame, and browsers stay on https.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
        ],
      },
    ];
  },
};

export default config;
