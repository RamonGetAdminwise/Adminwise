/**
 * Cuts the quoted history off an email body, so "the latest message" really is
 * only what the sender wrote this time. Works on the usual reply markers of
 * Outlook, Gmail and Apple Mail in EN, PL, DE and NL.
 */
const QUOTE_MARKERS: RegExp[] = [
  /^\s*-{2,}\s*(original message|wiadomość oryginalna|ursprüngliche nachricht|oorspronkelijk bericht)\s*-{2,}/i,
  /^\s*_{10,}\s*$/,
  /^\s*(on|am|op)\s.{5,120}\s(wrote|schrieb|schreef)\s*.*:\s*$/i,
  /^\s*(w dniu|dnia)\s.{5,120}\s(pisze|napisał|napisała|napisał\(a\))\s*:\s*$/i,
  /^\s*(from|od|von|van)\s*:\s.+$/i, // Outlook header block: From: ... / Sent: ...
];

export function stripQuotedHistory(body: string): string {
  const lines = body.split(/\r?\n/);
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (QUOTE_MARKERS.some((marker) => marker.test(line))) {
      // "From:" only counts as a marker when a second header line follows it.
      if (/^\s*(from|od|von|van)\s*:/i.test(line)) {
        const next = lines[i + 1] ?? "";
        if (!/^\s*(sent|wysłano|gesendet|verzonden|date|data|datum|to|do|an|aan)\s*:/i.test(next)) continue;
      }
      cut = i;
      break;
    }
    // A block of ">" quoted lines running to the end of the mail.
    if (/^\s*>/.test(line) && lines.slice(i).every((l) => /^\s*>/.test(l) || l.trim() === "")) {
      cut = i;
      break;
    }
  }
  const kept = lines.slice(0, cut).join("\n").trim();
  // If stripping removed everything, the mail was only a quote: keep the original.
  return kept || body.trim();
}

/** Keeps prompts bounded: long bodies are shortened in the middle, with a visible mark. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n[... shortened ...]\n${text.slice(-half)}`;
}
