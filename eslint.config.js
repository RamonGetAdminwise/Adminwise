import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { process: "readonly", console: "readonly", Buffer: "readonly", fetch: "readonly" } },
    rules: {
      // House rule: SQL lives only in packages/db. Everything else goes through
      // forCustomer() / system(), so every query is scoped by customer id.
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "pg", message: "Use the data layer in @adminwise/db (forCustomer / system) instead of raw SQL." }] },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='pool']",
          message: "Do not query the pool directly. Use forCustomer() / system() from @adminwise/db.",
        },
      ],
    },
  },
  {
    // The data layer itself, and the test database bootstrap, are the only places that may touch pg.
    files: ["packages/db/**", "test/**", "**/test/**"],
    rules: { "no-restricted-imports": "off", "no-restricted-syntax": "off" },
  },
);
