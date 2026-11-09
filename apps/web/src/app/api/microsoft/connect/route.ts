import { randomBytes } from "node:crypto";
import { buildAuthUrl } from "@bo/mail";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getConfig, getMicrosoftOAuth } from "@/lib/server";

/** Starts the Microsoft 365 sign-in. Also used as the reconnect link. */
export async function GET() {
  const config = getConfig();
  if (!(await getSession())) return NextResponse.redirect(`${config.appBaseUrl}/`);
  const oauth = getMicrosoftOAuth();
  if (!oauth) return NextResponse.redirect(`${config.appBaseUrl}/settings?error=microsoft_config`);

  // The state value ties Microsoft's answer to this browser (CSRF protection).
  const state = randomBytes(24).toString("base64url");
  (await cookies()).set("bo_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.appBaseUrl.startsWith("https://"),
    path: "/api/microsoft",
    maxAge: 600,
  });
  return NextResponse.redirect(buildAuthUrl(oauth, state));
}
