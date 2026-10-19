/*
 * `fetch` with a wall-clock timeout. Both the OAuth dynamic module and the
 * client-credentials module need it, and Node's built-in `fetch` doesn't
 * expose a timeout option until you wire one through AbortController. This
 * keeps the call sites readable and makes test injection (`fetchImpl`)
 * uniform — the helper accepts a `fetch` argument so the test can swap in
 * a stub.
 */

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  return fetchAndReadWithTimeout(fetchImpl, url, init, timeoutMs, async (res) => res);
}

/**
 * Like `fetchWithTimeout`, but the deadline also covers `read`. `fetch`
 * resolves once headers arrive, so a body that stalls mid-stream would
 * otherwise hang the caller forever. The read is raced against the abort so
 * a fetch implementation that ignores the signal still settles.
 */
export async function fetchAndReadWithTimeout<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  read: (res: Response) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timedOut = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(timeoutError(url, timeoutMs)), {
      once: true,
    });
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }).then(read),
      timedOut,
    ]);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw timeoutError(url, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function timeoutError(url: string, timeoutMs: number): Error {
  return new Error(`Request to ${url} timed out after ${timeoutMs}ms.`);
}
