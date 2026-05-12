/**
 * Indicators — pure-math technical analysis functions.
 * All functions accept plain number arrays and return number arrays
 * (or null where insufficient data), making them easy to unit-test
 * and reuse with any charting library.
 */
const Indicators = (() => {

  // ── Simple Moving Average ───────────────────────────────
  function sma(data, period) {
    return data.map((_, i) => {
      if (i < period - 1) return null;
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += data[j];
      return sum / period;
    });
  }

  // ── Exponential Moving Average ──────────────────────────
  function ema(data, period) {
    const k = 2 / (period + 1);
    const result = new Array(data.length).fill(null);
    let emaVal = null;

    for (let i = 0; i < data.length; i++) {
      if (data[i] == null) continue;

      if (emaVal === null) {
        // Seed: need `period` consecutive non-null values
        if (i >= period - 1) {
          let sum = 0;
          for (let j = i - period + 1; j <= i; j++) sum += data[j];
          emaVal = sum / period;
          result[i] = emaVal;
        }
      } else {
        emaVal = data[i] * k + emaVal * (1 - k);
        result[i] = emaVal;
      }
    }
    return result;
  }

  // ── Relative Strength Index (Wilder smoothing) ──────────
  function rsi(closes, period = 14) {
    const result = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return result;

    // Seed average gain/loss from the first `period` changes
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) avgGain += diff;
      else          avgLoss -= diff;
    }
    avgGain /= period;
    avgLoss /= period;

    result[period] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-10));

    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const gain = diff > 0 ?  diff : 0;
      const loss = diff < 0 ? -diff : 0;
      // Wilder smoothing (= RMA)
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      result[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-10));
    }
    return result;
  }

  // ── MACD (Moving Average Convergence/Divergence) ────────
  function macd(closes, fast = 12, slow = 26, signal = 9) {
    const fastEMA  = ema(closes, fast);
    const slowEMA  = ema(closes, slow);

    // MACD line = fast EMA − slow EMA
    const macdLine = closes.map((_, i) =>
      fastEMA[i] != null && slowEMA[i] != null
        ? fastEMA[i] - slowEMA[i]
        : null
    );

    // Signal line = EMA(macdLine, signal) — computed over non-null values,
    // then re-mapped back to original indices
    const nonNullMacd = macdLine.filter(v => v != null);
    const signalRaw   = ema(nonNullMacd, signal);

    const signalLine = new Array(closes.length).fill(null);
    let si = 0;
    for (let i = 0; i < closes.length; i++) {
      if (macdLine[i] != null) {
        signalLine[i] = signalRaw[si] ?? null;
        si++;
      }
    }

    const histogram = closes.map((_, i) =>
      macdLine[i] != null && signalLine[i] != null
        ? macdLine[i] - signalLine[i]
        : null
    );

    return { macdLine, signalLine, histogram };
  }

  // ── Bollinger Bands ─────────────────────────────────────
  function bollingerBands(closes, period = 20, stdDevMult = 2) {
    const middle = sma(closes, period);
    const upper  = new Array(closes.length).fill(null);
    const lower  = new Array(closes.length).fill(null);

    for (let i = period - 1; i < closes.length; i++) {
      const slice = closes.slice(i - period + 1, i + 1);
      const mean  = middle[i];
      const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
      const sd = Math.sqrt(variance);
      upper[i] = mean + stdDevMult * sd;
      lower[i] = mean - stdDevMult * sd;
    }
    return { upper, middle, lower };
  }

  return { sma, ema, rsi, macd, bollingerBands };
})();
