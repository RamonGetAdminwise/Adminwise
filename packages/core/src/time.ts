/**
 * Time-zone helpers. Customers store an IANA name ("Europe/Warsaw"); every
 * schedule is computed from it with the platform's own time-zone database.
 */

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function parts(instant: Date, timeZone: string) {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => Number(formatted.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The customer's wall clock at a given instant. */
export function localClock(instant: Date, timeZone: string): { date: string; minutesOfDay: number } {
  const p = parts(instant, timeZone);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, minutesOfDay: p.hour * 60 + p.minute };
}

/** The instant at which a local calendar day ("2026-11-09") starts in a time zone. */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d);
  let guess = target;
  // Two rounds settle days where the clock changes (daylight saving).
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess -= shown - target;
  }
  return new Date(guess);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
