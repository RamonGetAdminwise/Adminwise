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
  serverExternalPackages: ["pg", "pg-boss", "exceljs"],
  // Price lists (up to 5 MB) and logos are uploaded through forms.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  // Next would otherwise write an AGENTS.md file into this folder on every start.
  agentRules: false,
};

export default config;
