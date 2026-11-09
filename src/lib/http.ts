/** 外部サイトへのアクセス共通処理（タイムアウト・指数バックオフ付き再試行） */

export const USER_AGENT =
  process.env.HTTP_USER_AGENT ?? "PreconBuybackTracker/0.1 (+internal shop tool; low-frequency)";

export class HttpError extends Error {
  constructor(public status: number, public url: string, message?: string) {
    super(message ?? `HTTP ${status}: ${url}`);
  }
}

export interface FetchOpts {
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  headers?: Record<string, string>;
  /** テスト用に差し替え可能 */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, err: unknown) => void;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function isRetryable(err: unknown) {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  return true; // ネットワークエラー・タイムアウト
}

export async function fetchWithRetry(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { timeoutMs = 20_000, retries = 3, baseDelayMs = 1_000, fetchImpl = fetch, sleep: wait = sleep } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.8", ...opts.headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      if (!res.ok) throw new HttpError(res.status, url);
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === retries || !isRetryable(e)) break;
      opts.onRetry?.(attempt + 1, e);
      // 指数バックオフ + ゆらぎ（1s, 2s, 4s ... 上限30s）
      const delay = Math.min(30_000, baseDelayMs * 2 ** attempt) * (0.8 + Math.random() * 0.4);
      await wait(delay);
    }
  }
  throw lastErr;
}
