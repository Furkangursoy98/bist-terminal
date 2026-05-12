/**
 * BistAPI — fetch OHLCV candles from Yahoo Finance via CORS proxies.
 * Yahoo Finance uses the ".IS" suffix for BIST symbols (e.g. THYAO.IS).
 * Direct browser requests are blocked by CORS, so we route through a
 * public proxy with automatic fallback.
 */
const BistAPI = (() => {
  const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';

  // Ordered fallback list — first working proxy wins
  const PROXIES = [
    url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  ];

  async function fetchWithFallback(url) {
    let lastError;
    for (const makeProxied of PROXIES) {
      try {
        const res = await fetch(makeProxied(url), { signal: AbortSignal.timeout(12000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`All proxies failed. Last error: ${lastError?.message}`);
  }

  /**
   * Returns an array of OHLCV candle objects sorted by time.
   * Each object: { time: 'YYYY-MM-DD', open, high, low, close, volume }
   *
   * @param {string} symbol  e.g. 'THYAO.IS'
   * @param {string} interval  '1d' | '1wk' | '1mo'
   * @param {string} range   '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y'
   */
  async function fetchOHLCV(symbol, interval = '1d', range = '1y') {
    const url = `${YF_BASE}${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    const json = await fetchWithFallback(url);

    const result = json?.chart?.result?.[0];
    if (!result) {
      const errMsg = json?.chart?.error?.description || 'No data returned';
      throw new Error(errMsg);
    }

    const timestamps = result.timestamp ?? [];
    const { open, high, low, close, volume } = result.indicators.quote[0];

    return timestamps
      .map((t, i) => {
        if (open[i] == null || close[i] == null) return null;
        return {
          time:   toDateString(t),
          open:   round(open[i]),
          high:   round(high[i]),
          low:    round(low[i]),
          close:  round(close[i]),
          volume: volume[i] ?? 0,
        };
      })
      .filter(Boolean)
      // Deduplicate by date (keep last occurrence) — can happen near market open
      .reduce((acc, c) => {
        acc[c.time] = c;
        return acc;
      }, {});
    // Return as sorted array
  }

  async function fetchOHLCVArray(symbol, interval = '1d', range = '1y') {
    const map = await fetchOHLCV(symbol, interval, range);
    return Object.values(map).sort((a, b) => a.time.localeCompare(b.time));
  }

  function toDateString(unixSec) {
    const d = new Date(unixSec * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  return { fetchOHLCV: fetchOHLCVArray };
})();
