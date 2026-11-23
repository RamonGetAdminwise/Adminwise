import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { loadConfig } from "../packages/core/src/config";

/**
 * `pnpm check:drive`: one-off proof that the delegated permission
 * Files.ReadWrite.AppFolder works for a work or school mailbox.
 *
 * Open http://localhost:3000 , sign in and approve. The script then writes two
 * small test files into the app's own OneDrive folder, checks the behaviours
 * filing depends on, removes the test files and prints what happened.
 * It prints status codes and Microsoft's error codes only: no tokens, no file
 * contents. Nothing is stored.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: use real environment variables
}

const { microsoft } = loadConfig();
if (!microsoft) {
  console.log("MS_CLIENT_ID and MS_CLIENT_SECRET are not set.");
  process.exit(1);
}
const ms = microsoft;

const PORT = 3000;
const REDIRECT = `http://localhost:${PORT}/api/microsoft/callback`;
const SCOPES = "offline_access User.Read Files.ReadWrite.AppFolder";
const GRAPH = "https://graph.microsoft.com/v1.0";
const AUTHORITY = `https://login.microsoftonline.com/${ms.tenant}/oauth2/v2.0`;
const state = randomBytes(16).toString("hex");

const lines: string[] = [];
function report(step: string, ok: boolean, detail: string) {
  const line = `${ok ? "ok    " : "FAILED"}  ${step}: ${detail}`;
  lines.push(line);
  console.log(line);
}

async function graph(token: string, method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  const response = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    method,
    headers: { ...(path.startsWith("http") ? {} : { Authorization: `Bearer ${token}` }), ...init.headers },
    body: init.body,
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    // no body (204) or not JSON
  }
  const code = (json.error as { code?: string } | undefined)?.code ?? "";
  return { status: response.status, json, code };
}

async function runChecks(token: string, grantedScopes: string) {
  report("scopes granted", /files\.readwrite\.appfolder/i.test(grantedScopes), grantedScopes.replace(/\s+/g, ", "));

  const me = await graph(token, "GET", "/me?$select=userPrincipalName");
  const upn = String(me.json.userPrincipalName ?? "");
  report("signed-in account", me.status === 200, `@${upn.split("@")[1] ?? "unknown"} (work or school account)`);

  const root = await graph(token, "GET", "/me/drive/special/approot");
  const parent = (root.json.parentReference as { path?: string } | undefined)?.path ?? "";
  report(
    "app folder",
    root.status === 200,
    root.status === 200 ? `"${String(root.json.name)}" under ${parent.replace(/^\/drive\/root:?/, "/") || "/"}` : `${root.status} ${root.code}`,
  );

  const base = "/me/drive/special/approot:/_adminwise-check/2026-11";
  const conflict = "@microsoft.graph.conflictBehavior=fail";
  const text = { headers: { "Content-Type": "text/plain" } };

  const first = await graph(token, "PUT", `${base}/test.txt:/content?${conflict}`, { ...text, body: "Adminwise drive check" });
  report("upload into nested folders", first.status === 201 || first.status === 200, `${first.status} ${first.code}`);

  const second = await graph(token, "PUT", `${base}/test.txt:/content?${conflict}`, { ...text, body: "second file, same name" });
  report("same name is refused, not overwritten", second.status === 409, `${second.status} ${second.code}`);

  const session = await graph(token, "POST", `${base}/large.bin:/createUploadSession`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "fail" } }),
  });
  if (session.status === 200 && typeof session.json.uploadUrl === "string") {
    const size = 327_680 * 2;
    const chunk = await graph(token, "PUT", session.json.uploadUrl, {
      headers: { "Content-Length": String(size), "Content-Range": `bytes 0-${size - 1}/${size}` },
      body: new Uint8Array(size),
    });
    report("large-file upload session", chunk.status === 201 || chunk.status === 200, `${chunk.status} ${chunk.code}`);
  } else {
    report("large-file upload session", false, `${session.status} ${session.code}`);
  }

  // Isolation: with only the app-folder permission, the rest of the drive should be closed.
  // Counts only; no file names are printed.
  const outside = await graph(token, "GET", "/me/drive/root/children?$top=50&$select=id,folder,file");
  const items = Array.isArray(outside.json.value) ? (outside.json.value as { folder?: unknown }[]) : [];
  report(
    "cannot list the rest of the drive",
    outside.status !== 200 || items.length === 0,
    outside.status === 200
      ? `200, ${items.length} item(s) visible in the drive root (${items.filter((i) => i.folder).length} folders)`
      : `${outside.status} ${outside.code}`,
  );

  const mail = await graph(token, "GET", "/me/drive/root/search(q='pdf')?$top=5&$select=id");
  const found = Array.isArray(mail.json.value) ? mail.json.value.length : 0;
  report(
    "cannot search the rest of the drive",
    mail.status !== 200 || found === 0,
    mail.status === 200 ? `200, ${found} result(s)` : `${mail.status} ${mail.code}`,
  );

  // One tiny file outside the app folder, removed straight away if Microsoft accepts it.
  const stray = await graph(token, "PUT", `/me/drive/root:/_adminwise-outside-check.txt:/content?${conflict}`, {
    ...text,
    body: "Adminwise permission check; safe to delete",
  });
  const wrote = stray.status === 201 || stray.status === 200;
  report("cannot write outside the app folder", !wrote, wrote ? `${stray.status}: a file COULD be written to the drive root` : `${stray.status} ${stray.code}`);
  if (wrote) {
    const undo = await graph(token, "DELETE", "/me/drive/root:/_adminwise-outside-check.txt");
    report("stray test file removed", undo.status === 204, `${undo.status} ${undo.code}`);
  }

  const cleanup = await graph(token, "DELETE", "/me/drive/special/approot:/_adminwise-check");
  report("test files removed", cleanup.status === 204, `${cleanup.status} ${cleanup.code}`);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
  const page = (title: string, body: string) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:46rem;margin:3rem auto"><h1>${title}</h1>${body}</body>`);
  };

  if (url.pathname === "/") {
    const authorize = new URL(`${AUTHORITY}/authorize`);
    authorize.search = new URLSearchParams({
      client_id: ms.clientId,
      response_type: "code",
      redirect_uri: REDIRECT,
      response_mode: "query",
      scope: SCOPES,
      state,
      prompt: "select_account",
    }).toString();
    response.writeHead(302, { Location: authorize.toString() });
    response.end();
    return;
  }
  if (url.pathname !== "/api/microsoft/callback") {
    response.writeHead(404);
    response.end();
    return;
  }

  let failed = false;
  try {
    const error = url.searchParams.get("error");
    if (error) {
      report("Microsoft sign-in", false, `${error}: ${(url.searchParams.get("error_description") ?? "").slice(0, 300)}`);
      failed = true;
    } else if (url.searchParams.get("state") !== state || !url.searchParams.get("code")) {
      report("Microsoft sign-in", false, "unexpected answer (state mismatch); start again at http://localhost:3000");
      failed = true;
    } else {
      const tokenResponse = await fetch(`${AUTHORITY}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: ms.clientId,
          client_secret: ms.clientSecret,
          grant_type: "authorization_code",
          code: url.searchParams.get("code")!,
          redirect_uri: REDIRECT,
          scope: SCOPES,
        }),
      });
      const token = (await tokenResponse.json()) as { access_token?: string; scope?: string; error?: string; error_description?: string };
      if (!token.access_token) {
        report("token", false, `${token.error ?? tokenResponse.status}: ${(token.error_description ?? "").slice(0, 300)}`);
        failed = true;
      } else {
        await runChecks(token.access_token, token.scope ?? "");
        failed = lines.some((l) => l.startsWith("FAILED"));
      }
    }
  } catch (error) {
    report("check", false, error instanceof Error ? `${error.name}: ${error.message}` : "error");
    failed = true;
  }
  page(failed ? "Drive check: something failed" : "Drive check: all good", `<pre>${lines.join("\n").replace(/</g, "&lt;")}</pre><p>You can close this tab.</p>`);
  console.log(failed ? "RESULT: FAILED" : "RESULT: OK");
  setTimeout(() => process.exit(failed ? 1 : 0), 500);
});

server.listen(PORT, () => {
  console.log(`Waiting: open http://localhost:${PORT} in your browser, sign in and approve.`);
});
setTimeout(() => {
  console.log("RESULT: TIMEOUT (nobody signed in within 20 minutes)");
  process.exit(2);
}, 20 * 60_000);
