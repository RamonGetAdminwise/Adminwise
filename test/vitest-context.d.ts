import "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** Connection string of the test database, provided by test/global-setup.ts. */
    databaseUrl: string;
  }
}
