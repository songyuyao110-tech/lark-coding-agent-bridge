import { log } from '../core/logger';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;

export async function retryOutbound<T>(
  label: string,
  op: () => Promise<T>,
  opts: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryableOutboundError(err)) {
        throw err;
      }
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      log.warn('outbound', 'retry', {
        label,
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        reason: errorReason(err),
      });
      await delay(delayMs);
    }
  }

  throw lastErr;
}

function isRetryableOutboundError(err: unknown): boolean {
  const raw = unwrapError(err);
  const code = String((raw as { code?: unknown })?.code ?? '').toLowerCase();
  const message = errorReason(err).toLowerCase();

  return (
    code === 'send_timeout' ||
    code === 'etimedout' ||
    code === 'econnaborted' ||
    code === 'econnreset' ||
    code === 'enotfound' ||
    code === 'eai_again' ||
    message.includes('timeout') ||
    message.includes('fetch failed') ||
    message.includes('getaddrinfo') ||
    message.includes('socket hang up') ||
    message.includes('network error')
  );
}

function unwrapError(err: unknown): unknown {
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  return cause ?? err;
}

function errorReason(err: unknown): string {
  const raw = unwrapError(err);
  if (raw instanceof Error) return raw.message;
  if (err instanceof Error) return err.message;
  return String(raw ?? err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
