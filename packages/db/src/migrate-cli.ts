import { migrate } from "./migrate";

try {
  process.loadEnvFile("../../.env");
} catch {
  // no .env file: rely on real environment variables
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const applied = await migrate(url);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
