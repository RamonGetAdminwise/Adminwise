/**
 * The site can be reached under two addresses: the one the app lives at (APP_BASE_URL, for
 * example https://app.example.com) and the bare domain above it (https://example.com), which
 * people type from memory. The public pages are fine on both. The signed-in pages are not: the
 * sign-in links we mail lead to the app's address and a sign-in is remembered per address, so a
 * visitor who starts on the bare domain would be signed in on the other one and asked again.
 *
 * Returns the address to send the visitor on to, or null when the request is already where it
 * belongs. Only the domain directly above the app's own host is sent on; anything else (the
 * app's own host, localhost, an address we do not know) is left alone.
 */
export function homeAddress(requestHost: string | null, pathAndQuery: string, appBaseUrl: string | undefined): string | null {
  if (!requestHost || !appBaseUrl) return null;
  let app: URL;
  try {
    app = new URL(appBaseUrl);
  } catch {
    return null;
  }
  const host = requestHost.trim().toLowerCase().replace(/:\d+$/, "");
  const appHost = app.hostname.toLowerCase();
  // The bare domain is the app's host without its first label: app.example.com -> example.com.
  const bare = appHost.split(".").slice(1).join(".");
  if (!bare.includes(".") || host !== bare) return null;
  const path = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  return `${app.origin}${path}`;
}
