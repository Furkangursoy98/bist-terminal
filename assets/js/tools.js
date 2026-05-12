/**
 * tools.js — chart drawing tools.
 *
 * FibTool  — Fibonacci retracement levels (two-click, persisted per ticker)
 * RRTool   — Risk/Reward overlay (price lines + shaded HTML zone divs)
 *
 * Both modules are initialised in app.js:initCharts() after the series exist.
 */

// ─────────────────────────────────────────────────────────────────
// FibTool
// ─────────────────────────────────────────────────────────────────

const FibTool = (() => {
  const LEVELS = [
    { r: 0,     color: '#26a69aaa', label: '0%' },
    { r: 0.236, color: '#26c6daaa', label: '23.6%' },
    { r: 0.382, color: '#e3b341aa', label: '38.2%' },
    { r: 0.500, color: '#ff9800aa', label: '50%' },
    { r: 0.618, color: '#ef5350aa', label: '61.8%' },
    { r: 0.786, color: '#bc8cffaa', label: '78.6%' },
    { r: 1,     color: '#58a6ffaa', label: '100%' },
  ];

  let _series      = null;
  let _priceLines  = [];
  let _pendingPx   = null;   // first click price — null when idle

  function init(series) {
    _series = series;
  }

  /**
   * Feed each chart click price into this function when Fib mode is active.
   * Returns 'first'  — first point recorded, waiting for second.
   * Returns { status:'done', high, low } — levels drawn.
   */
  function handleClick(clickPrice) {
    if (_pendingPx === null) {
      _pendingPx = clickPrice;
      return 'first';
    }
    const high = Math.max(_pendingPx, clickPrice);
    const low  = Math.min(_pendingPx, clickPrice);
    _pendingPx = null;
    draw(high, low);
    return { status: 'done', high, low };
  }

  function draw(high, low) {
    detach();
    LEVELS.forEach(({ r, color, label }) => {
      const price = high - (high - low) * r;
      const pl = _series.createPriceLine({
        price, color,
        lineWidth:        1,
        lineStyle:        1,
        axisLabelVisible: true,
        title:            `Fib ${label}  ${price.toFixed(2)}`,
      });
      _priceLines.push(pl);
    });
  }

  /** Remove all price lines from the chart (does NOT clear localStorage). */
  function detach() {
    _priceLines.forEach(pl => { try { _series.removePriceLine(pl); } catch {} });
    _priceLines = [];
  }

  /** Restore saved levels from localStorage onto the current chart. */
  function restore(ticker) {
    const saved = load(ticker);
    if (saved) draw(saved.high, saved.low);
  }

  function save(ticker, high, low) {
    localStorage.setItem(
      `bist_fib_${ticker.replace('.IS', '')}`,
      JSON.stringify({ high, low })
    );
  }

  function load(ticker) {
    try {
      const raw = localStorage.getItem(`bist_fib_${ticker.replace('.IS', '')}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  /** Detach lines and remove from localStorage. */
  function clear(ticker) {
    detach();
    if (ticker) localStorage.removeItem(`bist_fib_${ticker.replace('.IS', '')}`);
  }

  function hasPending()    { return _pendingPx !== null; }
  function cancelPending() { _pendingPx = null; }
  function isActive()      { return _priceLines.length > 0; }

  return { init, handleClick, draw, detach, restore, save, load, clear, hasPending, cancelPending, isActive };
})();


// ─────────────────────────────────────────────────────────────────
// RRTool
// ─────────────────────────────────────────────────────────────────

const RRTool = (() => {
  let _series     = null;
  let _chart      = null;
  let _priceLines = [];
  let _live       = null;  // { entry, sl, tp } when drawn

  function init(series, chart) {
    _series = series;
    _chart  = chart;

    // Keep zone divs in sync with chart pan/zoom
    chart.subscribeCrosshairMove(_refresh);
    chart.timeScale().subscribeVisibleLogicalRangeChange(_refresh);
  }

  function _refresh() {
    if (_live) _positionZones(_live.entry, _live.sl, _live.tp);
  }

  /**
   * Draw price lines and shade the profit/loss zones.
   * Returns the R:R metrics object.
   */
  function draw(entry, sl, tp) {
    clearLines();
    _live = { entry, sl, tp };

    [
      { price: entry, color: '#e3b341', title: `Giriş  ${entry.toFixed(2)}` },
      { price: sl,    color: '#ef5350', title: `Stop   ${sl.toFixed(2)}` },
      { price: tp,    color: '#26a69a', title: `Hedef  ${tp.toFixed(2)}` },
    ].forEach(({ price, color, title }) => {
      _priceLines.push(_series.createPriceLine({
        price, color,
        lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title,
      }));
    });

    _positionZones(entry, sl, tp);
    return compute(entry, sl, tp);
  }

  function _positionZones(entry, sl, tp) {
    const eY = _series.priceToCoordinate(entry);
    const sY = _series.priceToCoordinate(sl);
    const tY = _series.priceToCoordinate(tp);
    if (eY == null || sY == null || tY == null) return;

    _applyZone('rr-profit-zone', Math.min(eY, tY), Math.abs(eY - tY));
    _applyZone('rr-loss-zone',   Math.min(eY, sY), Math.abs(eY - sY));
  }

  function _applyZone(id, top, height) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = 'block';
    el.style.top     = Math.max(0, top)   + 'px';
    el.style.height  = Math.max(2, height) + 'px';
  }

  function clearLines() {
    _priceLines.forEach(pl => { try { _series.removePriceLine(pl); } catch {} });
    _priceLines = [];
    _live = null;
    ['rr-profit-zone', 'rr-loss-zone'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }

  /** Pure calculation — no side-effects. */
  function compute(entry, sl, tp) {
    const risk   = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    const isLong = tp > entry;
    return {
      rr:    (reward / risk).toFixed(2),
      slPct: ((risk   / entry) * 100).toFixed(2),
      tpPct: ((reward / entry) * 100).toFixed(2),
      isLong,
    };
  }

  function isActive() { return _live !== null; }

  return { init, draw, clearLines, compute, isActive };
})();
