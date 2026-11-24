import { chromium, type Browser } from "playwright";
import type { PdfRenderer } from "./deps";

/**
 * Prints our own HTML pages (offers, order confirmations) to PDF with headless
 * Chromium. The page is one we generated ourselves, and the browser is still
 * locked down: scripts are off and every network request is refused, so a
 * document can only contain what was passed in.
 *
 * The browser starts on first use and is kept for later documents.
 */
export function createPdfRenderer(): PdfRenderer & { close(): Promise<void> } {
  let browser: Promise<Browser> | null = null;
  const start = () => {
    if (!browser) {
      const launching = chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] }).then((started) => {
        // A browser that crashes later must not be kept either: the next document starts a new one.
        started.on("disconnected", () => {
          if (browser === launching) browser = null;
        });
        return started;
      });
      browser = launching;
      // Try again next time instead of keeping a failed start forever.
      launching.catch(() => {
        if (browser === launching) browser = null;
      });
    }
    return browser;
  };

  return {
    async render(html) {
      const context = await (await start()).newContext({ javaScriptEnabled: false, offline: true });
      try {
        const page = await context.newPage();
        await page.route("**/*", (route) => route.abort());
        await page.setContent(html, { waitUntil: "load" });
        return new Uint8Array(await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
      } finally {
        await context.close();
      }
    },
    async close() {
      const running = browser;
      browser = null;
      if (running) await (await running).close();
    },
  };
}
