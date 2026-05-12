/**
 * Watchlist — persists a list of BIST tickers to localStorage and
 * provides a simple CRUD interface. The UI rendering is handled by
 * app.js so this module stays framework-agnostic.
 */
const Watchlist = (() => {
  const KEY = 'bist_watchlist';
  const DEFAULTS = ['THYAO.IS', 'AKBNK.IS', 'GARAN.IS', 'EREGL.IS', 'BIMAS.IS'];

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) && parsed.length ? parsed : [...DEFAULTS];
    } catch {
      return [...DEFAULTS];
    }
  }

  function save(list) {
    localStorage.setItem(KEY, JSON.stringify(list));
  }

  function add(ticker) {
    const list = load();
    if (!list.includes(ticker)) {
      list.push(ticker);
      save(list);
    }
    return list;
  }

  function remove(ticker) {
    const list = load().filter(t => t !== ticker);
    save(list);
    return list;
  }

  function contains(ticker) {
    return load().includes(ticker);
  }

  return { load, save, add, remove, contains };
})();
