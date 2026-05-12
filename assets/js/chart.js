/**
 * ChartManager — thin wrapper around TradingView Lightweight Charts v4.
 * Provides factory helpers and cross-chart time-scale synchronisation.
 */
const ChartManager = (() => {

  const BASE_OPTIONS = {
    layout: {
      background: { type: 'solid', color: '#131722' },
      textColor: '#787b86',
    },
    grid: {
      vertLines: { color: '#1e2230' },
      horzLines: { color: '#1e2230' },
    },
    crosshair: {
      mode: 0, // Normal
    },
    rightPriceScale: {
      borderColor: '#2a2e39',
      scaleMargins: { top: 0.05, bottom: 0.05 },
    },
    timeScale: {
      borderColor: '#2a2e39',
      timeVisible: true,
      secondsVisible: false,
    },
  };

  /**
   * Create a chart inside `containerId`.
   * @param {string} containerId
   * @param {object} overrides  merged into BASE_OPTIONS
   */
  function create(containerId, overrides = {}) {
    const container = document.getElementById(containerId);
    const options = deepMerge(BASE_OPTIONS, overrides, {
      width:  container.offsetWidth,
      height: container.offsetHeight,
    });
    const chart = LightweightCharts.createChart(container, options);

    // Keep chart width in sync with container on resize
    const ro = new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      chart.applyOptions({ width });
    });
    ro.observe(container);

    return chart;
  }

  // ── Series factories ────────────────────────────────────

  function addCandleSeries(chart) {
    return chart.addCandlestickSeries({
      upColor:        '#26a69a',
      downColor:      '#ef5350',
      borderVisible:  false,
      wickUpColor:    '#26a69a',
      wickDownColor:  '#ef5350',
    });
  }

  function addVolumeSeries(chart) {
    const series = chart.addHistogramSeries({
      priceFormat:  { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
      visible: false,
    });
    return series;
  }

  /**
   * Add a line series to a chart.
   * @param {object} chart
   * @param {string} color  CSS colour string
   * @param {number} lineWidth
   * @param {string} [priceScaleId]  default '' (right axis)
   */
  function addLineSeries(chart, color, lineWidth = 1.5, priceScaleId = '') {
    return chart.addLineSeries({
      color,
      lineWidth,
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId,
    });
  }

  function addHistogramSeries(chart, defaultColor, scaleMargins = { top: 0.1, bottom: 0 }) {
    const series = chart.addHistogramSeries({
      color:        defaultColor,
      priceFormat:  { type: 'price', precision: 4, minMove: 0.0001 },
      priceScaleId: 'hist',
    });
    chart.priceScale('hist').applyOptions({ scaleMargins, visible: false });
    return series;
  }

  // ── Cross-chart time-scale sync ─────────────────────────

  /**
   * Bidirectionally sync the visible time range of two charts.
   * Uses a lock flag to prevent infinite update loops.
   */
  function syncCharts(...charts) {
    let syncing = false;

    charts.forEach(source => {
      source.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (syncing || !range) return;
        syncing = true;
        charts.forEach(target => {
          if (target !== source) {
            target.timeScale().setVisibleLogicalRange(range);
          }
        });
        syncing = false;
      });
    });
  }

  // ── Helpers ─────────────────────────────────────────────

  function deepMerge(...objects) {
    const result = {};
    for (const obj of objects) {
      for (const [key, val] of Object.entries(obj)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          result[key] = deepMerge(result[key] || {}, val);
        } else {
          result[key] = val;
        }
      }
    }
    return result;
  }

  return { create, addCandleSeries, addVolumeSeries, addLineSeries, addHistogramSeries, syncCharts };
})();
