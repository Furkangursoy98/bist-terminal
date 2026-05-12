/**
 * DataCache — stale-while-revalidate localStorage cache for OHLCV data.
 *
 * TTL: 15 minutes (matches the Yahoo Finance delayed-data window).
 * On QuotaExceededError the oldest half of cache entries are evicted.
 */
const DataCache = (() => {
  const TTL    = 15 * 60 * 1000;   // 15 min in ms
  const PREFIX = 'bist_c_';

  function _key(ticker, interval, range) {
    return `${PREFIX}${ticker.replace('.IS', '')}_${interval}_${range}`;
  }

  /**
   * Returns cached candles if they exist and are within TTL, otherwise null.
   * Caller should still fetch fresh data in the background (stale-while-revalidate).
   */
  function get(ticker, interval, range) {
    try {
      const raw = localStorage.getItem(_key(ticker, interval, range));
      if (!raw) return null;
      const { candles, ts } = JSON.parse(raw);
      return Date.now() - ts <= TTL ? candles : null;
    } catch { return null; }
  }

  /** Persist candles. Evicts oldest entries on storage quota overflow. */
  function set(ticker, interval, range, candles) {
    const entry = JSON.stringify({ candles, ts: Date.now() });
    try {
      localStorage.setItem(_key(ticker, interval, range), entry);
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        _evictOldest();
        try { localStorage.setItem(_key(ticker, interval, range), entry); } catch {}
      }
    }
  }

  /**
   * Returns the age of the cached entry in milliseconds, or null if absent.
   * Useful for showing "last updated X min ago" in the status bar.
   */
  function ageMs(ticker, interval, range) {
    try {
      const raw = localStorage.getItem(_key(ticker, interval, range));
      return raw ? Date.now() - JSON.parse(raw).ts : null;
    } catch { return null; }
  }

  function _evictOldest() {
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      try {
        const { ts } = JSON.parse(localStorage.getItem(k));
        entries.push({ k, ts });
      } catch { entries.push({ k, ts: 0 }); }
    }
    entries.sort((a, b) => a.ts - b.ts);
    entries.slice(0, Math.ceil(entries.length / 2))
           .forEach(({ k }) => localStorage.removeItem(k));
  }

  return { get, set, ageMs };
})();
