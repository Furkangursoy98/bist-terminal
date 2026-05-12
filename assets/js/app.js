/**
 * App — main controller (Phase 4).
 *
 * New in Phase 4:
 *   · Fibonacci retracement — two-click, per-ticker localStorage persistence
 *   · Live price-crossing alerts — visual flash + Web Audio API beep + mute toggle
 *   · Risk/Reward overlay — floating input panel, price lines, shaded zones
 *   · Comparison mode — two normalised tickers on the main chart
 *   · Stale-while-revalidate data cache (15-min TTL via DataCache)
 */
const App = (() => {

  // ── Chart handles ────────────────────────────────────────
  let mainChart, rsiChart, macdChart, rsChart;

  // ── Main series ──────────────────────────────────────────
  let candleSeries, volumeSeries;
  let sma20Series, sma50Series, ema100Series, ema200Series;
  let bbUpperSeries, bbLowerSeries;
  // Comparison mode normalised lines
  let comp1Series, comp2Series;

  // ── Sub-panel series ─────────────────────────────────────
  let rsiSeries, macdLineSeries, macdSignalSeries, macdHistSeries;
  let rsTickerSeries, rsIndexSeries;

  // ── App state ────────────────────────────────────────────
  const state = {
    ticker:    'THYAO.IS',
    interval:  '1d',
    range:     '1y',
    alertMode: false,
    fibMode:   false,
    fibClick1: null,      // price of first fib click
    compMode:  false,
    ticker2:   'PGSUS.IS',
    muted:     localStorage.getItem('bist_muted') === '1',
  };

  // ── Alert lines ──────────────────────────────────────────
  let alertLines = [];
  const ALERT_COLORS = ['#26a69a','#ef5350','#e3b341','#58a6ff','#bc8cff','#ff9800'];

  // ── Price-crossing detection ─────────────────────────────
  let lastKnownPrice = null;
  let _audioCtx      = null;  // lazily created

  // ── Sector → index map ───────────────────────────────────
  const SECTOR_INDEX    = { 'Bankacılık': 'XBANK.IS' };
  const tickerSectorMap = new Map();

  // ── Watchlist price cache ─────────────────────────────────
  const wlPriceCache = new Map();

  // ── Chart-data presence flag ──────────────────────────────
  // Once charts have data, background failures stay silent.
  let hasData = false;

  // ── R/R state ────────────────────────────────────────────
  const rrState = { entry: null, sl: null, tp: null, isLong: true };

  // ─────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────

  function initCharts() {
    mainChart = ChartManager.create('main-chart');

    const subOpts = {
      rightPriceScale: { scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { visible: false },
    };
    rsiChart  = ChartManager.create('rsi-chart',  subOpts);
    macdChart = ChartManager.create('macd-chart', subOpts);
    rsChart   = ChartManager.create('rs-chart', {
      ...subOpts,
      timeScale: { visible: true, borderColor: '#30363d', timeVisible: true, secondsVisible: false },
    });

    // Main series
    candleSeries  = ChartManager.addCandleSeries(mainChart);
    volumeSeries  = ChartManager.addVolumeSeries(mainChart);
    sma20Series   = ChartManager.addLineSeries(mainChart, '#e3b341', 1.5);
    sma50Series   = ChartManager.addLineSeries(mainChart, '#58a6ff', 1.5);
    ema100Series  = ChartManager.addLineSeries(mainChart, '#26c6da', 1.5);
    ema200Series  = ChartManager.addLineSeries(mainChart, '#ef5350', 1.5);
    bbUpperSeries = ChartManager.addLineSeries(mainChart, '#bc8cff88', 1);
    bbLowerSeries = ChartManager.addLineSeries(mainChart, '#bc8cff88', 1);

    [ema100Series, ema200Series, bbUpperSeries, bbLowerSeries].forEach(s =>
      s.applyOptions({ visible: false })
    );
    bbUpperSeries.applyOptions({ lineStyle: 2 });
    bbLowerSeries.applyOptions({ lineStyle: 2 });

    // Comparison mode lines (hidden by default)
    comp1Series = ChartManager.addLineSeries(mainChart, '#26a69a', 2);
    comp2Series = ChartManager.addLineSeries(mainChart, '#58a6ff', 2);
    comp1Series.applyOptions({ visible: false });
    comp2Series.applyOptions({ visible: false });

    // RSI
    rsiSeries = ChartManager.addLineSeries(rsiChart, '#ab47bc', 1.5);
    rsiSeries.createPriceLine({ price: 70, color: '#ef535066', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'OB' });
    rsiSeries.createPriceLine({ price: 30, color: '#26a69a66', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'OS' });

    // MACD
    macdLineSeries   = ChartManager.addLineSeries(macdChart, '#58a6ff', 1.5);
    macdSignalSeries = ChartManager.addLineSeries(macdChart, '#ff9800', 1.5);
    macdHistSeries   = ChartManager.addHistogramSeries(macdChart, '#26a69a99');

    // RS panel
    rsTickerSeries = ChartManager.addLineSeries(rsChart, '#26a69a', 1.5);
    rsIndexSeries  = ChartManager.addLineSeries(rsChart, '#484f58', 1);
    rsTickerSeries.createPriceLine({ price: 100, color: '#30363d', lineWidth: 1, lineStyle: 1, axisLabelVisible: false });

    // Sync time scales
    ChartManager.syncCharts(mainChart, rsiChart, macdChart, rsChart);

    // Initialise drawing tools
    FibTool.init(candleSeries);
    RRTool.init(candleSeries, mainChart);

    // Single chart click handler — branches on active mode
    mainChart.subscribeClick(param => {
      if (!param.point) return;
      const price = candleSeries.coordinateToPrice(param.point.y);
      if (price == null) return;

      if (state.alertMode) {
        addAlertLine(price);
        exitAlertMode();
        return;
      }
      if (state.fibMode) {
        const result = FibTool.handleClick(price);
        if (result === 'first') {
          setStatus('loading', 'Fib: ikinci noktayı seçin…');
          document.getElementById('fib-status').textContent = `1. nokta: ${price.toFixed(2)} — 2. noktayı seçin`;
        } else {
          FibTool.save(state.ticker, result.high, result.low);
          exitFibMode(true);
          document.getElementById('fib-status').textContent =
            `${result.low.toFixed(2)} – ${result.high.toFixed(2)}`;
          setStatus('ready', `Fibonacci seviyeleri çizildi: ${result.low.toFixed(2)} – ${result.high.toFixed(2)}`);
        }
      }
    });
  }

  function bindControls() {
    // Ticker
    document.getElementById('ticker-select').addEventListener('change', e => {
      if (!e.target.value) return;
      document.getElementById('ticker-input').value = '';
      setActiveTicker(e.target.value);
    });
    document.getElementById('ticker-input').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const raw = e.target.value.trim().toUpperCase();
      if (!raw) return;
      e.target.value = '';
      document.getElementById('ticker-select').value = '';
      setActiveTicker(raw.includes('.') ? raw : raw + '.IS');
    });
    document.getElementById('interval-select').addEventListener('change', e => { state.interval = e.target.value; loadData(); });
    document.getElementById('range-select').addEventListener('change', e => { state.range = e.target.value; loadData(); });

    // Comparison second ticker
    document.getElementById('comp-ticker-select').addEventListener('change', e => {
      if (!e.target.value) return;
      state.ticker2 = e.target.value;
      if (state.compMode) loadData();
    });

    // Overlay toggles
    [
      ['toggle-sma20',  () => sma20Series],
      ['toggle-sma50',  () => sma50Series],
      ['toggle-ema100', () => ema100Series],
      ['toggle-ema200', () => ema200Series],
    ].forEach(([id, getSeries]) => {
      document.getElementById(id).addEventListener('change', e =>
        getSeries().applyOptions({ visible: e.target.checked })
      );
    });
    document.getElementById('toggle-bb').addEventListener('change', e => {
      [bbUpperSeries, bbLowerSeries].forEach(s => s.applyOptions({ visible: e.target.checked }));
    });

    // Watchlist
    document.getElementById('btn-add-watchlist').addEventListener('click', () => {
      Watchlist.add(state.ticker); renderWatchlist();
    });

    // Alert lines
    document.getElementById('btn-add-line').addEventListener('click', toggleAlertMode);
    document.getElementById('btn-alert-mode').addEventListener('click', toggleAlertMode);
    document.getElementById('btn-clear-lines').addEventListener('click', clearAlertLines);

    // Fibonacci
    document.getElementById('btn-fib-mode').addEventListener('click', toggleFibMode);
    document.getElementById('btn-clear-fib').addEventListener('click', () => {
      FibTool.clear(state.ticker);
      document.getElementById('fib-status').textContent = '—';
      document.getElementById('btn-fib-mode').textContent = 'Fib';
      document.getElementById('btn-fib-mode').classList.remove('active');
    });

    // R/R panel
    document.getElementById('btn-rr-toggle').addEventListener('click', toggleRRPanel);
    document.getElementById('rr-close').addEventListener('click', closeRRPanel);
    document.getElementById('rr-dir-long').addEventListener('click',  () => setRRDir(true));
    document.getElementById('rr-dir-short').addEventListener('click', () => setRRDir(false));
    ['rr-entry', 'rr-sl', 'rr-tp'].forEach(id =>
      document.getElementById(id).addEventListener('input', computeAndDrawRR)
    );

    // Comparison mode
    document.getElementById('btn-comp-mode').addEventListener('click', toggleComparisonMode);

    // Export
    document.getElementById('btn-export').addEventListener('click', exportChartImage);

    // Mobile quick-view
    document.getElementById('btn-mobile-mode').addEventListener('click', toggleMobileMode);

    // Mute
    document.getElementById('btn-mute').addEventListener('click', toggleMute);
    _applyMuteUI();

    // Sidebar collapse
    const sidebar = document.getElementById('sidebar');
    document.getElementById('btn-collapse-sidebar').addEventListener('click', function () {
      const col = sidebar.classList.toggle('collapsed');
      this.textContent = col ? '▶' : '◀';
    });

    // Global Escape — cancel any active drawing mode
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (state.alertMode) exitAlertMode();
      if (state.fibMode)   exitFibMode(false);
    });
  }

  // ─────────────────────────────────────────────────────────
  // WATCHLIST
  // ─────────────────────────────────────────────────────────

  function renderWatchlist() {
    const list = Watchlist.load();
    const ul   = document.getElementById('watchlist');
    ul.innerHTML = '';

    list.forEach(ticker => {
      const cached = wlPriceCache.get(ticker);
      const li     = document.createElement('li');
      li.className = 'watchlist-item' + (ticker === state.ticker ? ' active' : '');

      const dot  = document.createElement('span'); dot.className = 'wl-dot';
      const sym  = document.createElement('span'); sym.className = 'wl-ticker'; sym.textContent = ticker.replace('.IS', '');

      const tile   = document.createElement('span'); tile.className = 'wl-price-tile';
      const prEl   = document.createElement('span'); prEl.className = cached ? 'wl-price' : 'wl-price loading'; prEl.textContent = cached ? cached.price : '…';
      const pctEl  = document.createElement('span'); pctEl.className = cached ? `wl-pct ${cached.dir}` : 'wl-pct'; pctEl.textContent = cached?.pct ?? '';
      tile.append(prEl, pctEl);

      const rm = document.createElement('button'); rm.className = 'wl-remove'; rm.textContent = '×';

      li.append(dot, sym, tile, rm);
      sym.addEventListener('click', () => setActiveTicker(ticker));
      rm.addEventListener('click', e => { e.stopPropagation(); Watchlist.remove(ticker); renderWatchlist(); });
      ul.appendChild(li);
    });
  }

  // ── Background watchlist sync ─────────────────────────────
  // One-by-one sequential queue with a 60s gap between each fetch.
  // The loop runs forever; active-ticker fetches bypass the queue.
  let _bgSyncRunning = false;

  async function _runBgSync() {
    if (_bgSyncRunning) return;
    _bgSyncRunning = true;
    try {
      while (true) {
        if (document.visibilityState !== 'hidden') {
          const list = Watchlist.load();
          for (const ticker of list) {
            await _fetchWatchlistTicker(ticker);
            // Dedicated Worker: 10s between tickers — responsive but not aggressive.
            // Public proxies: 60s hard wait to stay under limits.
            await delay(BistAPI.usingDedicated() ? 10_000 : 60_000);
          }
        } else {
          await delay(60_000); // tab hidden — check again in 1 min
        }
      }
    } finally {
      _bgSyncRunning = false;
    }
  }

  async function _fetchWatchlistTicker(ticker) {
    try {
      const candles = await BistAPI.fetchOHLCV(ticker, '1d', '5d');
      if (candles.length >= 2) {
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const pct  = (last.close - prev.close) / prev.close * 100;
        // Only update the tile on success — stale data stays if fetch fails
        wlPriceCache.set(ticker, {
          price: last.close.toFixed(2),
          pct:   (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%',
          dir:   pct >= 0 ? 'up' : 'down',
        });
        if (ticker === state.ticker) checkPriceCrossings(last.close);
        renderWatchlist();
      }
    } catch {
      // Total silence — log only, never touch the error UI
      console.debug(`[bgSync] ${ticker} fetch skipped`);
    }
  }

  function startWatchlistUpdater() {
    _runBgSync(); // fire-and-forget perpetual loop
  }

  function setActiveTicker(ticker) {
    state.ticker = ticker;
    lastKnownPrice = null;  // reset crossing tracker on ticker switch
    renderWatchlist();
    loadData();
  }

  // ─────────────────────────────────────────────────────────
  // ALERT LINES
  // ─────────────────────────────────────────────────────────

  function toggleAlertMode() { state.alertMode ? exitAlertMode() : enterAlertMode(); }

  function enterAlertMode() {
    if (state.fibMode) exitFibMode(false);
    state.alertMode = true;
    ['btn-alert-mode', 'btn-add-line'].forEach(id =>
      document.getElementById(id)?.classList.add('active')
    );
    document.getElementById('charts-container').classList.add('alert-mode-active');
    setStatus('loading', 'Destek/direnç çizgisi: grafiğe tıklayın  [ESC = iptal]');
  }

  function exitAlertMode() {
    state.alertMode = false;
    ['btn-alert-mode', 'btn-add-line'].forEach(id =>
      document.getElementById(id)?.classList.remove('active')
    );
    document.getElementById('charts-container').classList.remove('alert-mode-active');
    setStatus('ready', `${state.ticker} — hazır`);
  }

  function addAlertLine(price) {
    const id    = `al_${Date.now()}`;
    const color = ALERT_COLORS[alertLines.length % ALERT_COLORS.length];
    const pl    = candleSeries.createPriceLine({
      price, color, lineWidth: 1, lineStyle: 1,
      axisLabelVisible: true, title: price.toFixed(2),
    });
    alertLines.push({ id, price, color, priceLine: pl });
    _saveAlertLines();
    renderAlertLineList();
  }

  function removeAlertLine(id) {
    const idx = alertLines.findIndex(a => a.id === id);
    if (idx === -1) return;
    try { candleSeries.removePriceLine(alertLines[idx].priceLine); } catch {}
    alertLines.splice(idx, 1);
    _saveAlertLines();
    renderAlertLineList();
  }

  function clearAlertLines() {
    alertLines.forEach(a => { try { candleSeries.removePriceLine(a.priceLine); } catch {} });
    alertLines = [];
    _saveAlertLines();
    renderAlertLineList();
  }

  function detachAlertLines() {
    alertLines.forEach(a => { try { candleSeries.removePriceLine(a.priceLine); } catch {} });
    alertLines = [];
  }

  function reattachAlertLines() {
    const key = `bist_alerts_${state.ticker.replace('.IS', '')}`;
    let saved;
    try { saved = JSON.parse(localStorage.getItem(key)) || []; } catch { saved = []; }
    saved.forEach(({ id, price, color }) => {
      const pl = candleSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: price.toFixed(2) });
      alertLines.push({ id, price, color, priceLine: pl });
    });
    renderAlertLineList();
  }

  function _saveAlertLines() {
    const key  = `bist_alerts_${state.ticker.replace('.IS', '')}`;
    localStorage.setItem(key, JSON.stringify(alertLines.map(({ id, price, color }) => ({ id, price, color }))));
  }

  function renderAlertLineList() {
    const ul = document.getElementById('alert-lines-list');
    ul.innerHTML = '';
    if (!alertLines.length) {
      const li = document.createElement('li');
      li.style.cssText = 'padding:4px 12px;color:var(--text-muted);font-family:var(--font-mono);font-size:9px';
      li.textContent = 'henüz çizgi yok';
      ul.appendChild(li); return;
    }
    [...alertLines].sort((a, b) => b.price - a.price).forEach(al => {
      const li     = document.createElement('li'); li.className = 'alert-line-item';
      const sw     = document.createElement('span'); sw.className = 'al-swatch'; sw.style.background = al.color;
      const pr     = document.createElement('span'); pr.className = 'al-price'; pr.textContent = al.price.toFixed(2);
      const rm     = document.createElement('button'); rm.className = 'al-remove'; rm.textContent = '×';
      rm.addEventListener('click', () => removeAlertLine(al.id));
      li.append(sw, pr, rm); ul.appendChild(li);
    });
  }

  // ─────────────────────────────────────────────────────────
  // FIBONACCI
  // ─────────────────────────────────────────────────────────

  function toggleFibMode() {
    if (FibTool.isActive() && !state.fibMode) {
      // Already drawn — clear on click
      FibTool.clear(state.ticker);
      document.getElementById('fib-status').textContent = '—';
      document.getElementById('btn-fib-mode').textContent = 'Fib';
      document.getElementById('btn-fib-mode').classList.remove('active');
      return;
    }
    state.fibMode ? exitFibMode(false) : enterFibMode();
  }

  function enterFibMode() {
    if (state.alertMode) exitAlertMode();
    state.fibMode = true;
    const btn = document.getElementById('btn-fib-mode');
    btn.classList.add('active');
    btn.textContent = 'Fib ·';
    FibTool.cancelPending();
    document.getElementById('charts-container').classList.add('alert-mode-active');
    setStatus('loading', 'Fibonacci: 1. nokta için grafiğe tıklayın  [ESC = iptal]');
  }

  function exitFibMode(drawn) {
    state.fibMode = false;
    FibTool.cancelPending();
    const btn = document.getElementById('btn-fib-mode');
    btn.textContent = drawn ? 'Fib ✓' : 'Fib';
    btn.classList.toggle('active', drawn && FibTool.isActive());
    document.getElementById('charts-container').classList.remove('alert-mode-active');
  }

  // ─────────────────────────────────────────────────────────
  // AUDIO / VISUAL ALERTS
  // ─────────────────────────────────────────────────────────

  function checkPriceCrossings(currentPrice) {
    if (lastKnownPrice === null) { lastKnownPrice = currentPrice; return; }
    const prev = lastKnownPrice;
    lastKnownPrice = currentPrice;
    alertLines.forEach(al => {
      const crossed = (prev < al.price && currentPrice >= al.price) ||
                      (prev > al.price && currentPrice <= al.price);
      if (crossed) triggerAlert(al, currentPrice);
    });
  }

  function triggerAlert(line, price) {
    // Visual: flash ticker label
    const el = document.getElementById('ticker-label');
    el.classList.remove('alert-flash');
    void el.offsetWidth; // reflow to restart animation
    el.classList.add('alert-flash');
    setTimeout(() => el.classList.remove('alert-flash'), 1300);

    // Status bar notification
    setStatus('ready', `⚡ ${state.ticker} — fiyat ${line.price.toFixed(2)} seviyesini geçti! (${price.toFixed(2)})`);

    if (!state.muted) playAlertSound();
  }

  function playAlertSound() {
    try {
      if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx  = _audioCtx;
      const buf  = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
      const data = buf.getChannelData(0);
      // Two-tone descending blip
      for (let i = 0; i < data.length; i++) {
        const t    = i / ctx.sampleRate;
        const freq = 880 - (880 - 440) * (t / 0.25);
        const env  = Math.exp(-t * 12);
        data[i] = Math.sin(2 * Math.PI * freq * t) * env * 0.25;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
    } catch (e) { console.warn('Audio alert:', e); }
  }

  function toggleMute() {
    state.muted = !state.muted;
    localStorage.setItem('bist_muted', state.muted ? '1' : '0');
    _applyMuteUI();
  }

  function _applyMuteUI() {
    const btn = document.getElementById('btn-mute');
    if (!btn) return;
    btn.textContent = state.muted ? '🔕' : '🔔';
    btn.classList.toggle('muted', state.muted);
    btn.title = state.muted ? 'Ses kapalı — aç' : 'Ses açık — kapat';
  }

  // ─────────────────────────────────────────────────────────
  // RISK / REWARD
  // ─────────────────────────────────────────────────────────

  function toggleRRPanel() {
    const panel = document.getElementById('rr-panel');
    const isOpen = panel.style.display !== 'none';
    if (isOpen) {
      closeRRPanel();
    } else {
      panel.style.display = 'block';
      document.getElementById('btn-rr-toggle').classList.add('active');
      // Pre-fill entry with last close if available
      const cached = wlPriceCache.get(state.ticker);
      if (cached && !document.getElementById('rr-entry').value) {
        document.getElementById('rr-entry').value = parseFloat(cached.price).toFixed(2);
        computeAndDrawRR();
      }
    }
  }

  function closeRRPanel() {
    document.getElementById('rr-panel').style.display = 'none';
    document.getElementById('btn-rr-toggle').classList.remove('active');
    RRTool.clearLines();
    ['rr-entry', 'rr-sl', 'rr-tp'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('rr-result').innerHTML = '';
  }

  function setRRDir(isLong) {
    rrState.isLong = isLong;
    document.getElementById('rr-dir-long').classList.toggle('active', isLong);
    document.getElementById('rr-dir-short').classList.toggle('active', !isLong);
    computeAndDrawRR();
  }

  function computeAndDrawRR() {
    const entry = parseFloat(document.getElementById('rr-entry').value);
    const sl    = parseFloat(document.getElementById('rr-sl').value);
    const tp    = parseFloat(document.getElementById('rr-tp').value);
    const res   = document.getElementById('rr-result');

    if (!entry || !sl || !tp || isNaN(entry) || isNaN(sl) || isNaN(tp)) {
      res.innerHTML = ''; RRTool.clearLines(); return;
    }
    if (Math.abs(entry - sl) < 0.001) { res.innerHTML = ''; return; }

    const { rr, slPct, tpPct, isLong } = RRTool.draw(entry, sl, tp);
    const rrNum  = parseFloat(rr);
    const rrCls  = rrNum >= 2 ? 'rr-good' : rrNum >= 1 ? '' : 'rr-bad';
    const sign   = isLong ? '+' : '−';

    res.innerHTML =
      `<span style="color:var(--text-muted)">Giriş : </span>${entry.toFixed(2)}\n` +
      `<span style="color:var(--accent-red)">Stop  : </span>${sl.toFixed(2)}  (-${slPct}%)\n` +
      `<span style="color:var(--accent-green)">Hedef : </span>${tp.toFixed(2)}  (${sign}${tpPct}%)\n` +
      `<span style="color:var(--text-muted)">R/R   : </span><span class="${rrCls}">${rr}:1</span>`;
  }

  // ─────────────────────────────────────────────────────────
  // COMPARISON MODE
  // ─────────────────────────────────────────────────────────

  function toggleComparisonMode() {
    state.compMode ? exitComparisonMode() : enterComparisonMode();
  }

  function enterComparisonMode() {
    state.compMode = true;
    document.getElementById('btn-comp-mode').classList.add('active');
    document.getElementById('comp-control').style.display = 'flex';
    // Hide normal main-chart overlays
    [candleSeries, volumeSeries, sma20Series, sma50Series,
     ema100Series, ema200Series, bbUpperSeries, bbLowerSeries]
      .forEach(s => s.applyOptions({ visible: false }));
    comp1Series.applyOptions({ visible: true });
    comp2Series.applyOptions({ visible: true });
    loadData();
  }

  function exitComparisonMode() {
    state.compMode = false;
    document.getElementById('btn-comp-mode').classList.remove('active');
    document.getElementById('comp-control').style.display = 'none';
    comp1Series.applyOptions({ visible: false });
    comp2Series.applyOptions({ visible: false });
    // Restore toggles-driven visibility
    [
      ['toggle-sma20',  sma20Series],
      ['toggle-sma50',  sma50Series],
      ['toggle-ema100', ema100Series],
      ['toggle-ema200', ema200Series],
    ].forEach(([id, s]) => s.applyOptions({ visible: !!document.getElementById(id)?.checked }));
    candleSeries.applyOptions({ visible: true });
    volumeSeries.applyOptions({ visible: true });
    const bbOn = document.getElementById('toggle-bb')?.checked;
    bbUpperSeries.applyOptions({ visible: !!bbOn });
    bbLowerSeries.applyOptions({ visible: !!bbOn });
    setText('main-panel-label', 'Fiyat / Hacim');
    loadData();
  }

  // ─────────────────────────────────────────────────────────
  // DATA LOADING  (stale-while-revalidate)
  // ─────────────────────────────────────────────────────────

  async function loadData() {
    const { ticker, interval, range } = state;
    const compIndex = getComparisonIndex(ticker);

    document.getElementById('ticker-label').textContent = ticker.replace('.IS', '');
    document.getElementById('price-display').innerHTML = '<span style="color:var(--text-muted)">—</span>';
    clearBadges();
    detachAlertLines();
    FibTool.detach();

    // ── Serve from cache immediately (stale-while-revalidate) ──
    const cachedMain = DataCache.get(ticker, interval, range);
    if (cachedMain) {
      const cachedIdx = DataCache.get(compIndex, interval, range);
      _renderAll(cachedMain, cachedIdx, compIndex);
      reattachAlertLines();
      FibTool.restore(ticker);
      const age = DataCache.ageMs(ticker, interval, range);
      const ageStr = age != null ? ` · önbellekten (${Math.round(age / 60000)}d önce)` : '';
      setStatus('loading', `${ticker} güncelleniyor…${ageStr}`);
    } else {
      setOverlay(true, 'Veri bekleniyor…');
      setStatus('loading', `${ticker} verisi alınıyor…`);
    }

    // ── Fetch fresh data ──────────────────────────────────────
    try {
      const fetchIdx = state.compMode
        ? BistAPI.fetchOHLCV(state.ticker2, interval, range).catch(() => null)
        : BistAPI.fetchOHLCV(compIndex, interval, range).catch(() => null);

      const [candles, secondaryCandles] = await Promise.all([
        BistAPI.fetchOHLCV(ticker, interval, range),
        fetchIdx,
      ]);

      if (!candles.length) throw new Error('Veri bulunamadı');

      DataCache.set(ticker, interval, range, candles);
      if (secondaryCandles) DataCache.set(
        state.compMode ? state.ticker2 : compIndex,
        interval, range, secondaryCandles
      );

      if (!cachedMain) {
        // First load — attach lines after initial render
        _renderAll(candles, secondaryCandles, compIndex);
        reattachAlertLines();
        FibTool.restore(ticker);
      } else {
        // Refresh — just update chart data silently
        _renderAll(candles, secondaryCandles, compIndex);
      }

      setStatus('ready', `${ticker} — ${candles.length} bar` +
        (state.compMode ? ` ⇌ ${state.ticker2.replace('.IS','')}` : ` · ${compIndex.replace('.IS','')}`)
      );
      updateStatusTime();
    } catch (err) {
      console.error('[loadData]', err);

      // Stale-cache fallback: render whatever exists so charts never go blank
      if (!cachedMain) {
        const stale    = DataCache.getStale(ticker, interval, range);
        const staleIdx = DataCache.getStale(compIndex, interval, range);
        if (stale) {
          _renderAll(stale, staleIdx, compIndex);
          reattachAlertLines();
          FibTool.restore(ticker);
        }
      }

      const retryIn = 10;
      if (hasData) {
        // Charts are populated — keep them visible, just note the hiccup quietly
        setStatus('ready', `⚠ Güncelleme başarısız — ${retryIn}sn içinde tekrar deneniyor`);
      } else {
        // True cold start with nothing to show — spinner overlay + neutral message
        setOverlay(true, 'Veri bekleniyor…');
        setStatus('loading', `Bağlantı kuruluyor… ${retryIn}sn içinde tekrar denenecek`);
      }
      setTimeout(() => {
        if (state.ticker === ticker) loadData();
      }, retryIn * 1000);
    } finally {
      setOverlay(false);
    }
  }

  function _renderAll(candles, secondaryCandles, compIndex) {
    if (state.compMode) {
      renderComparisonChart(candles, secondaryCandles);
    } else {
      renderCharts(candles, secondaryCandles, compIndex);
    }
    renderPriceBar(candles);
    hasData = true;
    // Re-position R/R zones if active
    if (RRTool.isActive()) computeAndDrawRR();
  }

  // ─────────────────────────────────────────────────────────
  // RENDERING
  // ─────────────────────────────────────────────────────────

  function renderCharts(candles, indexCandles, compIndex) {
    const closes = candles.map(c => c.close);

    candleSeries.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
    volumeSeries.setData(candles.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? '#26a69a44' : '#ef535044' })));

    sma20Series.setData(zipTime(candles, Indicators.sma(closes, 20)));
    sma50Series.setData(zipTime(candles, Indicators.sma(closes, 50)));
    ema100Series.setData(zipTime(candles, Indicators.ema(closes, 100)));
    ema200Series.setData(zipTime(candles, Indicators.ema(closes, 200)));

    const { upper: bbU, lower: bbL } = Indicators.bollingerBands(closes, 20, 2);
    bbUpperSeries.setData(zipTime(candles, bbU));
    bbLowerSeries.setData(zipTime(candles, bbL));

    const rsiVals = Indicators.rsi(closes, 14);
    rsiSeries.setData(zipTime(candles, rsiVals));
    const lastRSI = [...rsiVals].reverse().find(v => v != null) ?? null;

    const { macdLine, signalLine, histogram } = Indicators.macd(closes);
    macdLineSeries.setData(zipTime(candles, macdLine));
    macdSignalSeries.setData(zipTime(candles, signalLine));
    macdHistSeries.setData(zipTime(candles, histogram).map(d => ({ ...d, color: d.value >= 0 ? '#26a69a99' : '#ef535099' })));

    if (indexCandles?.length) {
      const { tickerNorm, indexNorm } = calcRelativeStrength(candles, indexCandles);
      rsTickerSeries.setData(tickerNorm);
      rsIndexSeries.setData(indexNorm);
    } else {
      rsTickerSeries.setData([]); rsIndexSeries.setData([]);
    }

    setText('rs-panel-label', `Göreli Performans / ${compIndex.replace('.IS', '')} (baz=100)`);
    updateBadges(candles, lastRSI);

    // Seed price-crossing tracker
    if (lastKnownPrice === null && candles.length) {
      lastKnownPrice = candles[candles.length - 1].close;
    }
  }

  function renderComparisonChart(candles1, candles2) {
    if (!candles2?.length) {
      comp1Series.setData(candles1.map(c => ({ time: c.time, value: c.close })));
      comp2Series.setData([]);
      setText('main-panel-label', `${state.ticker.replace('.IS','')} — karşılaştırma verisi yok`);
      return;
    }
    const map2   = new Map(candles2.map(c => [c.time, c.close]));
    const shared = candles1.filter(c => map2.has(c.time));
    if (!shared.length) { comp1Series.setData([]); comp2Series.setData([]); return; }

    const b1 = shared[0].close;
    const b2 = map2.get(shared[0].time);
    comp1Series.setData(shared.map(c => ({ time: c.time, value: (c.close / b1) * 100 })));
    comp2Series.setData(shared.map(c => ({ time: c.time, value: (map2.get(c.time) / b2) * 100 })));

    const t1 = state.ticker.replace('.IS','');
    const t2 = state.ticker2.replace('.IS','');
    setText('main-panel-label', `${t1} vs ${t2} — normalise edilmiş (baz=100)`);
    // Update sub-panels with ticker1 data
    const closes = candles1.map(c => c.close);
    const rsiVals = Indicators.rsi(closes, 14);
    rsiSeries.setData(zipTime(candles1, rsiVals));
    const { macdLine, signalLine, histogram } = Indicators.macd(closes);
    macdLineSeries.setData(zipTime(candles1, macdLine));
    macdSignalSeries.setData(zipTime(candles1, signalLine));
    macdHistSeries.setData(zipTime(candles1, histogram).map(d => ({ ...d, color: d.value >= 0 ? '#26a69a99' : '#ef535099' })));
    updateBadges(candles1, [...rsiVals].reverse().find(v => v != null) ?? null);
  }

  function renderPriceBar(candles) {
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const diff = last.close - prev.close;
    const pct  = (diff / prev.close) * 100;
    const dir  = diff >= 0 ? 'up' : 'down';
    const sign = diff >= 0 ? '+' : '';
    document.getElementById('price-display').innerHTML =
      `<span class="price">${last.close.toFixed(2)}</span>` +
      `<span class="change ${dir}">${sign}${diff.toFixed(2)} (${sign}${pct.toFixed(2)}%)</span>`;
  }

  // ─────────────────────────────────────────────────────────
  // RELATIVE STRENGTH
  // ─────────────────────────────────────────────────────────

  function calcRelativeStrength(tickerCandles, indexCandles) {
    const m = new Map(indexCandles.map(c => [c.time, c.close]));
    const s = tickerCandles.filter(c => m.has(c.time));
    if (s.length < 2) return { tickerNorm: [], indexNorm: [] };
    const t0 = s[0].close, i0 = m.get(s[0].time);
    return {
      tickerNorm: s.map(c => ({ time: c.time, value: (c.close / t0) * 100 })),
      indexNorm:  s.map(c => ({ time: c.time, value: (m.get(c.time) / i0) * 100 })),
    };
  }

  function getComparisonIndex(ticker) {
    return SECTOR_INDEX[tickerSectorMap.get(ticker)] || 'XU100.IS';
  }

  // ─────────────────────────────────────────────────────────
  // EXPORT
  // ─────────────────────────────────────────────────────────

  async function exportChartImage() {
    const btn = document.getElementById('btn-export');
    btn.textContent = '…'; btn.disabled = true;
    try {
      const t      = state.ticker.replace('.IS', '');
      const panels = [
        { chart: mainChart,  label: state.compMode ? `${t} vs ${state.ticker2.replace('.IS','')}` : 'FİYAT' },
        { chart: rsiChart,   label: 'RSI (14)' },
        { chart: macdChart,  label: 'MACD (12,26,9)' },
        { chart: rsChart,    label: `RS / ${getComparisonIndex(state.ticker).replace('.IS','')}` },
      ];
      const snaps = panels.map(p => p.chart.takeScreenshot());
      const W = snaps[0].width, PAD = 40;
      const H = snaps.reduce((h, s) => h + s.height, 0) + PAD;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#161b22'; ctx.fillRect(0, 0, W, PAD);
      ctx.fillStyle = '#58a6ff'; ctx.font = 'bold 13px monospace'; ctx.fillText('BIST/terminal', 12, 26);
      ctx.fillStyle = '#c9d1d9'; ctx.font = '12px monospace';
      ctx.fillText(`${t}  ${state.interval}  ${state.range}  ${new Date().toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })}`, 150, 26);
      let y = PAD;
      snaps.forEach((snap, i) => {
        ctx.drawImage(snap, 0, y);
        ctx.fillStyle = '#484f58'; ctx.font = '9px monospace'; ctx.fillText(panels[i].label, 8, y + 12);
        y += snap.height;
      });
      cv.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${t}_${Date.now()}.png`; a.click();
        URL.revokeObjectURL(url);
      }, 'image/png');
      setStatus('ready', `PNG indirildi — ${t}`);
    } catch (err) {
      setStatus('error', `Dışa aktarma hatası: ${err.message}`);
    } finally {
      btn.textContent = '↓ Dışa Aktar'; btn.disabled = false;
    }
  }

  // ─────────────────────────────────────────────────────────
  // SUMMARY BADGES
  // ─────────────────────────────────────────────────────────

  function updateBadges(candles, lastRSI) {
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const diff = last.close - prev.close;
    const pct  = (diff / prev.close) * 100;
    const sign = diff >= 0 ? '+' : '';

    setText('badge-price', last.close.toFixed(2));
    const chEl = document.getElementById('badge-change');
    if (chEl) { chEl.textContent = `${sign}${pct.toFixed(2)}%`; chEl.className = `badge-value ${diff >= 0 ? 'up' : 'down'}`; }

    if (lastRSI != null) {
      const rEl = document.getElementById('badge-rsi');
      const rW  = document.getElementById('badge-rsi-wrap');
      if (rEl) { rEl.textContent = lastRSI.toFixed(1); rEl.className = lastRSI > 70 ? 'badge-value rsi-high' : lastRSI < 30 ? 'badge-value rsi-low' : 'badge-value'; }
      if (rW)  rW.className = lastRSI > 70 ? 'badge overbought' : lastRSI < 30 ? 'badge oversold' : 'badge';
    }
    const vol = last.volume;
    setText('badge-volume', vol >= 1e9 ? `${(vol/1e9).toFixed(1)}B` : vol >= 1e6 ? `${(vol/1e6).toFixed(1)}M` : vol >= 1e3 ? `${(vol/1e3).toFixed(0)}K` : String(vol));
  }

  function clearBadges() {
    ['badge-price','badge-change','badge-rsi','badge-volume'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = '—'; el.className = 'badge-value'; }
    });
    const w = document.getElementById('badge-rsi-wrap');
    if (w) w.className = 'badge';
  }

  // ─────────────────────────────────────────────────────────
  // TICKER DROPDOWN
  // ─────────────────────────────────────────────────────────

  async function populateSelect(selectId, preselect) {
    try {
      const res  = await fetch('data/bist-tickers.json');
      const data = await res.json();
      const sel  = document.getElementById(selectId);
      data.groups.forEach(group => {
        const og = document.createElement('optgroup'); og.label = group.label;
        group.tickers.forEach(t => {
          if (selectId === 'ticker-select') tickerSectorMap.set(t.symbol, group.label);
          const opt = document.createElement('option');
          opt.value = t.symbol; opt.textContent = `${t.symbol.replace('.IS','')} – ${t.name}`;
          if (t.symbol === preselect) opt.selected = true;
          og.appendChild(opt);
        });
        sel.appendChild(og);
      });
    } catch (e) { console.warn('Ticker listesi:', e); }
  }

  // ─────────────────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────────────────

  function zipTime(candles, values) {
    return candles.map((c, i) => values[i] != null ? { time: c.time, value: values[i] } : null).filter(Boolean);
  }
  function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
  function setStatus(type, msg) { document.getElementById('status-bar').className = `status-bar ${type}`; setText('status-text', msg); }
  function setOverlay(v, label) {
    const el = document.getElementById('loading-overlay');
    el.classList.toggle('visible', v);
    if (label) {
      const txt = el.querySelector('span') || el.lastChild;
      if (txt && txt.nodeType === Node.TEXT_NODE) txt.textContent = label;
    }
  }
  function updateStatusTime() { setText('status-time', new Date().toLocaleTimeString('tr-TR')); }
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ─────────────────────────────────────────────────────────
  // MARKET STATUS
  // ─────────────────────────────────────────────────────────

  function getBistStatus() {
    const now      = new Date();
    const istanbul = new Date(now.getTime() + now.getTimezoneOffset() * 60_000 + 3 * 3_600_000);
    const day  = istanbul.getDay();                                    // 0=Sun 6=Sat
    const mins = istanbul.getHours() * 60 + istanbul.getMinutes();

    if (day === 0 || day === 6)                          return { status: 'closed', label: 'KAPALI' };
    if (mins < 9 * 60 + 40 || mins >= 18 * 60 + 10)     return { status: 'closed', label: 'KAPALI' };
    if (mins >= 10 * 60 && mins < 18 * 60)               return { status: 'open',   label: 'AÇIK'   };
    return                                                      { status: 'pre',    label: 'SEANS'  };
  }

  function updateMarketStatus() {
    const dot = document.getElementById('market-dot');
    const lbl = document.getElementById('market-label');
    if (!dot || !lbl) return;
    const { status, label } = getBistStatus();
    dot.className  = `market-dot ${status}`;
    lbl.textContent = label;
    dot.parentElement.title = `BIST: ${label} (İstanbul saati)`;
  }

  function initMarketStatus() {
    updateMarketStatus();
    setInterval(updateMarketStatus, 60_000);
  }

  // ─────────────────────────────────────────────────────────
  // MOBILE QUICK-VIEW
  // ─────────────────────────────────────────────────────────

  function toggleMobileMode() {
    const active = document.body.classList.toggle('mobile-mode');
    document.getElementById('btn-mobile-mode').classList.toggle('active', active);
    // Resize all charts so LW Charts fills the new height
    setTimeout(() => {
      [mainChart, rsiChart, macdChart, rsChart].forEach(c => {
        const el = c.options().width; // touch the chart to trigger internal resize
        c.applyOptions({ width: c.options().width });
      });
    }, 50);
  }

  // ─────────────────────────────────────────────────────────
  // RESPONSIVE AUTO-COLLAPSE
  // ─────────────────────────────────────────────────────────

  function initResponsive() {
    // Auto-collapse sidebar when viewport narrows below 900 px
    // Uses ResizeObserver on the app body so it reacts to split-screen etc.
    if (!window.ResizeObserver) return;
    const body   = document.querySelector('.app-body');
    const sidebar = document.getElementById('sidebar');
    const colBtn  = document.getElementById('btn-collapse-sidebar');
    if (!body || !sidebar) return;

    let userCollapsed = false; // track manual overrides

    // If user clicks collapse button, flag it so auto doesn't fight back
    colBtn?.addEventListener('click', () => { userCollapsed = sidebar.classList.contains('collapsed'); });

    new ResizeObserver(entries => {
      const w = entries[0].contentRect.width;
      if (w < 900 && !sidebar.classList.contains('collapsed')) {
        sidebar.classList.add('collapsed');
        if (colBtn) colBtn.textContent = '▶';
      } else if (w >= 900 && !userCollapsed && sidebar.classList.contains('collapsed')) {
        sidebar.classList.remove('collapsed');
        if (colBtn) colBtn.textContent = '◀';
      }
    }).observe(body);
  }

  // ─────────────────────────────────────────────────────────
  // SERVICE WORKER REGISTRATION
  // ─────────────────────────────────────────────────────────

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .catch(err => console.warn('SW registration failed:', err));
  }

  // ─────────────────────────────────────────────────────────
  // ENTRY POINT
  // ─────────────────────────────────────────────────────────

  async function init() {
    registerServiceWorker();

    await Promise.all([
      populateSelect('ticker-select',      state.ticker),
      populateSelect('comp-ticker-select', state.ticker2),
    ]);
    initCharts();
    bindControls();
    renderWatchlist();
    renderAlertLineList();
    initMarketStatus();
    initResponsive();
    startWatchlistUpdater();
    loadData();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
