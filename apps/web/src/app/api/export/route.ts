import { forCustomer } from "@adminwise/db";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getConfig, getDb } from "@/lib/server";

/**
 * "Download my data": everything stored for the signed-in customer, as one JSON
 * file. Mailbox keys, sign-in tokens and file contents are never in it.
 */
export async function GET() {
  const config = getConfig();
  const session = await getSession();
  if (!session) return NextResponse.redirect(`${config.appBaseUrl}/signin`);

  const scope = forCustomer(getDb(), session.customerId);
  const data = await scope.exportData();
  await scope.audit("data.exported", {}, session.userId);
  const day = new Date().toISOString().slice(0, 10);
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), product: config.appName, ...data }, null, 2);
  return new NextResponse(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="adminwise-export-${day}.json"`,
      "cache-control": "no-store",
    },
  });
}
