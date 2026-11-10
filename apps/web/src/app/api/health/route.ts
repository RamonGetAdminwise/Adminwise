import { system } from "@adminwise/db";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Used by the hosting platform to see that the web app and its database are up. */
export async function GET() {
  try {
    await system(getDb()).ping();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
