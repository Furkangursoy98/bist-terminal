/**
 * BistAPI — fetch OHLCV candles from Yahoo Finance via CORS proxies.
 * Yahoo Finance uses the ".IS" suffix for BIST symbols (e.g. THYAO.IS).
 * Direct browser requests are blocked by CORS, so we route through a
 * public proxy with automatic fallback.
 */
const BistAPI = (() => {
  const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';

  // Ordered fallback list — first working proxy wins.
  // Proxies that return HTML error pages on rate-limit are detected and skipped.
  const PROXIES = [
    url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://corsproxy.org/?${encodeURIComponent(url)}`,
    url => `https://thingproxy.freeboard.io/fetch/${url}`,
    url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  ];

  function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function _safeFetch(proxied) {
    const res = await fetch(proxied, { signal: AbortSignal.timeout(12000) });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Reject HTML error pages that some proxies return with 200 OK on rate-limit
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      throw new Error(`Proxy returned HTML (likely rate-limited)`);
    }

    const text = await res.text();
    if (!text || !text.trimStart().startsWith('{')) {
      throw new Error(`Non-JSON body: ${text.slice(0, 80)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`JSON parse failed: ${text.slice(0, 80)}`);
    }
  }

  async function fetchWithFallback(url) {
    let lastError;
    for (let i = 0; i < PROXIES.length; i++) {
      if (i > 0) await _delay(1000); // 1s pause between proxies to avoid cascading 429s
      try {
        return await _safeFetch(PROXIES[i](url));
      } catch (err) {
        lastError = err;
        console.warn(`[BistAPI] Proxy ${i + 1}/${PROXIES.length} failed:`, err.message);
      }
    }
    throw new Error(`Tüm veri kaynakları yanıt vermedi. Son hata: ${lastError?.message}`);
  }

  /**
   * Returns an array of OHLCV candle objects sorted by time.
   * Each object: { time: 'YYYY-MM-DD', open, high, low, close, volume }
   *
   * @param {string} symbol   e.g. 'THYAO.IS'
   * @param {string} interval '1d' | '1wk' | '1mo'
   * @param {string} range    '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y'
   */
  async function fetchOHLCV(symbol, interval = '1d', range = '1y') {
    const url  = `${YF_BASE}${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    const json = await fetchWithFallback(url);

    const result = json?.chart?.result?.[0];
    if (!result) {
      const errMsg = json?.chart?.error?.description || 'Veri bulunamadı';
      throw new Error(errMsg);
    }

    const timestamps = result.timestamp ?? [];
    const { open, high, low, close, volume } = result.indicators.quote[0];

    return timestamps
      .map((t, i) => {
        if (open[i] == null || close[i] == null) return null;
        return {
          time:   _toDateString(t),
          open:   _round(open[i]),
          high:   _round(high[i]),
          low:    _round(low[i]),
          close:  _round(close[i]),
          volume: volume[i] ?? 0,
        };
      })
      .filter(Boolean)
      // Deduplicate by date (keep last occurrence) — can happen near market open
      .reduce((acc, c) => { acc[c.time] = c; return acc; }, {});
  }

  async function _fetchArray(symbol, interval = '1d', range = '1y') {
    const map = await fetchOHLCV(symbol, interval, range);
    return Object.values(map).sort((a, b) => a.time.localeCompare(b.time));
  }

  function _toDateString(unixSec) {
    const d   = new Date(unixSec * 1000);
    const y   = d.getUTCFullYear();
    const m   = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function _round(n) { return Math.round(n * 100) / 100; }

  return { fetchOHLCV: _fetchArray };
})();
