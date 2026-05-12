/**
 * BistAPI — fetch OHLCV candles from Yahoo Finance.
 *
 * Priority order:
 *   1. DEDICATED_PROXY — your Cloudflare Worker (set the URL below after deploying)
 *   2. Public CORS proxy fallback chain (5 proxies, shuffled, 1s inter-proxy delay)
 *
 * Set DEDICATED_PROXY to your Worker URL to skip public proxies entirely.
 * Leave it empty ('') to use only the public fallback chain.
 */
const BistAPI = (() => {

  // ── Paste your Cloudflare Worker URL here after deploying ──────────
  // Example: 'https://bist-proxy.yourname.workers.dev'
  const DEDICATED_PROXY = 'https://bist-proxy.furkann-gursoy1.workers.dev';
  // ───────────────────────────────────────────────────────────────────

  const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';

  // Public fallback chain — used only when DEDICATED_PROXY is empty or fails
  const PUBLIC_PROXIES = [
    url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://corsproxy.org/?${encodeURIComponent(url)}`,
    url => `https://thingproxy.freeboard.io/fetch/${url}`,
    url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  ];

  // Whether the last fetch used the dedicated proxy successfully
  let _usingDedicated = false;

  function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function _safeFetch(fetchUrl) {
    const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html')) throw new Error('Proxy returned HTML (rate-limited)');

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

  async function fetchWithFallback(yfUrl, symbol, interval, range) {
    // ── 1. Dedicated Cloudflare Worker ────────────────────────────────
    if (DEDICATED_PROXY) {
      try {
        const workerUrl = `${DEDICATED_PROXY}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&range=${range}`;
        const json = await _safeFetch(workerUrl);
        _usingDedicated = true;
        return json;
      } catch (err) {
        _usingDedicated = false;
        console.warn('[BistAPI] Dedicated proxy failed, falling back:', err.message);
      }
    }

    // ── 2. Public proxy fallback chain ────────────────────────────────
    _usingDedicated = false;
    let lastError;
    const proxies = [...PUBLIC_PROXIES].sort(() => Math.random() - 0.5);
    for (let i = 0; i < proxies.length; i++) {
      if (i > 0) await _delay(1000);
      try {
        return await _safeFetch(proxies[i](yfUrl));
      } catch (err) {
        lastError = err;
        console.warn(`[BistAPI] Public proxy ${i + 1}/${proxies.length} failed:`, err.message);
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
    const yfUrl = `${YF_BASE}${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    const json  = await fetchWithFallback(yfUrl, symbol, interval, range);

    const result = json?.chart?.result?.[0];
    if (!result) {
      const errMsg = json?.chart?.error?.description || 'Veri bulunamadı';
      throw new Error(errMsg);
    }

    const timestamps = result.timestamp ?? [];
    const { open, high, low, close, volume } = result.indicators.quote[0];

    return Object.values(
      timestamps
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
        .reduce((acc, c) => { acc[c.time] = c; return acc; }, {})
    ).sort((a, b) => a.time.localeCompare(b.time));
  }

  function _toDateString(unixSec) {
    const d   = new Date(unixSec * 1000);
    const y   = d.getUTCFullYear();
    const m   = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function _round(n) { return Math.round(n * 100) / 100; }

  /** True if the most recent fetch succeeded via the dedicated Worker. */
  function usingDedicated() { return _usingDedicated; }

  return { fetchOHLCV, usingDedicated };
})();
