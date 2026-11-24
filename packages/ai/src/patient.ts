import type { AiClient } from "./client";

export interface PatienceOptions {
  /** How many times one request is tried in total. */
  attempts: number;
  /** Wait before the second try; doubles each time, up to `maxMs`. */
  baseMs: number;
  maxMs: number;
  /** For tests: stands in for waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** For tests: stands in for chance (0 to 1). */
  random?: () => number;
}

/** Long enough to ride out a busy minute at the model provider; used by the worker. */
export const WORKER_PATIENCE: PatienceOptions = { attempts: 7, baseMs: 2_000, maxMs: 45_000 };
/** A person is waiting for the page: try once more, then say it did not work. */
export const WEB_PATIENCE: PatienceOptions = { attempts: 2, baseMs: 1_500, maxMs: 1_500 };

/** "Too many requests right now" or "overloaded": worth waiting for. Anything else is a real error. */
export function isBusy(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 429 || status === 503 || status === 529) return true;
  return error instanceof Error && /\b(429|529)\b|too many requests|throttl|overloaded|rate.?limit/i.test(error.message);
}

/**
 * Wraps a model client so that "too busy" is answered by waiting and trying
 * again, with a longer wait each time and some randomness so that several
 * waiting jobs do not all return in the same second.
 *
 * Without this, a burst of mail turns into failed jobs: the provider allows a
 * limited number of requests a minute, and a refused request used to fail the
 * whole job, which the queue then retried half a minute later.
 */
export function withPatience(client: AiClient, options: PatienceOptions = WORKER_PATIENCE): AiClient {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  return {
    async complete(request) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await client.complete(request);
        } catch (error) {
          if (!isBusy(error) || attempt >= options.attempts) throw error;
          const wait = Math.min(options.maxMs, options.baseMs * 2 ** (attempt - 1));
          // Between half and the whole of the wait.
          await sleep(Math.round(wait * (0.5 + random() / 2)));
        }
      }
    },
  };
}
