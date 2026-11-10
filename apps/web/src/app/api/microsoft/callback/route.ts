import { QUEUES } from "@adminwise/core";
import { forCustomer } from "@adminwise/db";
import { exchangeCode, GraphClient } from "@adminwise/mail";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getConfig, getDb, getMicrosoftOAuth, getQueue } from "@/lib/server";

/** Microsoft sends the customer back here after they approve the connection. */
export async function GET(request: NextRequest) {
  const config = getConfig();
  const fail = () => NextResponse.redirect(`${config.appBaseUrl}/settings?error=microsoft`);

  const session = await getSession();
  if (!session) return NextResponse.redirect(`${config.appBaseUrl}/`);
  const oauth = getMicrosoftOAuth();
  if (!oauth) return NextResponse.redirect(`${config.appBaseUrl}/settings?error=microsoft_config`);

  const jar = await cookies();
  const expectedState = jar.get("aw_oauth_state")?.value;
  jar.delete({ name: "aw_oauth_state", path: "/api/microsoft" });
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state || !expectedState || state !== expectedState) return fail();

  try {
    const tokens = await exchangeCode(oauth, code);
    const me = await new GraphClient(tokens.accessToken).getMe();
    const scope = forCustomer(getDb(), session.customerId);
    // Reconnecting keeps the stored bookmark, so mail that arrived while
    // disconnected is picked up by the first poll.
    const connection = await scope.upsertConnection({
      provider: "microsoft",
      emailAddress: me.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiresAt,
    });
    await scope.audit("mailbox.connected", { provider: "microsoft", connectionId: connection.id }, session.userId);
    // First poll now: it also registers the change-notification subscription.
    await (await getQueue()).send(QUEUES.syncMailbox, { customerId: session.customerId, connectionId: connection.id });
  } catch (error) {
    console.error("[microsoft callback]", error instanceof Error ? `${error.name}: ${error.message}` : "error");
    return fail();
  }
  return NextResponse.redirect(`${config.appBaseUrl}/settings?saved=connected`);
}
