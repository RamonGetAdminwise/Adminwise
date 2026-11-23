/**
 * The Adminwise logo (docs/BRAND.md).
 *
 * The mark is a lowercase "a" whose bowl holds a tick: admin, done. It sits on
 * a rounded square in the brand colour. The wordmark is the name in lowercase,
 * "admin" in ink and "wise" in the brand colour.
 * Keep clear space of half the mark's width around the logo, and never stretch,
 * recolour or outline it.
 */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} role="img" aria-label="Adminwise">
      <rect width="32" height="32" rx="8" fill="#0b855b" />
      <circle cx="14.4" cy="17" r="6.6" fill="none" stroke="#fff" strokeWidth="3" />
      <path d="M22.5 10.4v13.2" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <path d="M11.4 17.2l2.3 2.3 4-4.5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Mark and wordmark together. `tone="light"` is for dark backgrounds. */
export function Logo({ size = 28, tone = "dark" }: { size?: number; tone?: "dark" | "light" }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={size} />
      <span
        className={`font-display font-bold lowercase leading-none tracking-tight ${tone === "light" ? "text-white" : "text-ink"}`}
        style={{ fontSize: Math.round(size * 0.72) }}
      >
        admin<span className={tone === "light" ? "text-brand-300" : "text-brand-600"}>wise</span>
      </span>
    </span>
  );
}
