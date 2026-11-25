import { NextResponse, type NextRequest } from "next/server";
import { homeAddress } from "./lib/home-address";

/**
 * Sends a visitor who opens a signed-in page on the bare domain on to the app's own address, so
 * that signing in happens in one place. See lib/home-address.ts. The public pages and /api are
 * not touched.
 */
export function proxy(request: NextRequest) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const target = homeAddress(host, `${request.nextUrl.pathname}${request.nextUrl.search}`, process.env.APP_BASE_URL);
  // 307: the method is kept, so a form posted on the bare domain is not lost.
  return target ? NextResponse.redirect(target, 307) : NextResponse.next();
}

export const config = {
  matcher: ["/signin", "/auth/:path*", "/start/:path*", "/settings/:path*", "/invoice", "/offer", "/thread"],
};
