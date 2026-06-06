// ATL Ticker Analyzer — Chart Module
// Candlesticks + Volume bars + EMA (20 / 50 / 200)
// Real-time: live price line + current forming candle update

let chart = null, candleSeries = null, volumeSeries = null;
let ema20Series = null, ema50Series = null, ema200Series = null;
let livePriceLine = null;
let liveTickerInterval = null;
let _currentSymbol = null;

// ── Init Main Chart ─────────────────────────────────────────
function initChart(container) {
  container.innerHTML = '';

  // Stop any previous live ticker
  if (liveTickerInterval) { clearInterval(liveTickerInterval); liveTickerInterval = null; }

  chart = LightweightCharts.createChart(container, {
    layout: {
      background:  { color: '#080b0f' },
      textColor:   '#5a6470',
      fontSize:    11,
      fontFamily:  "'Share Tech Mono', monospace",
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.04)' },
      horzLines: { color: 'rgba(255,255,255,0.04)' },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: 'rgba(0,230,118,0.3)', labelBackgroundColor: '#0d1117' },
      horzLine: { color: 'rgba(0,230,118,0.3)', labelBackgroundColor: '#0d1117' },
    },
    rightPriceScale: {
      borderColor:  'rgba(255,255,255,0.07)',
      scaleMargins: { top: 0.12, bottom: 0.12 },
    },
    timeScale: {
      borderColor:    'rgba(255,255,255,0.07)',
      timeVisible:    true,
      secondsVisible: false,
      rightOffset:    8,     // leave breathing room to the right of last candle
    },
    width:  container.offsetWidth,
    height: container.offsetHeight || 420,
  });

  // Candlesticks
  candleSeries = chart.addCandlestickSeries({
    upColor:         '#00e676',
    downColor:       '#ff4444',
    borderUpColor:   '#00e676',
    borderDownColor: '#ff4444',
    wickUpColor:     '#00e676',
    wickDownColor:   '#ff4444',
    priceLineVisible: false,
  });

  // Volume bars — overlaid on a separate scale, low opacity
  volumeSeries = chart.addHistogramSeries({
    color:       'rgba(255,255,255,0.12)',
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
    lastValueVisible: false,
    priceLineVisible: false,
  });
  chart.priceScale('vol').applyOptions({
    scaleMargins: { top: 0.80, bottom: 0 },
  });

  // Resize observer
  const ro = new ResizeObserver(() => {
    chart.applyOptions({ width: container.offsetWidth, height: container.offsetHeight || 420 });
  });
  ro.observe(container);

  return chart;
}

// ── Load Candles + Volume ────────────────────────────────────
function loadCandles(candles) {
  if (!candleSeries || !candles.length) return;

  candleSeries.setData(candles);

  // Volume bars
  if (volumeSeries) {
    volumeSeries.setData(candles.map(c => ({
      time:  c.time,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(0,230,118,0.18)' : 'rgba(255,68,68,0.18)',
    })));
  }

  // Show last ~80 candles so recent action is visible and readable
  const visibleBars = Math.min(80, candles.length);
  chart.timeScale().setVisibleLogicalRange({
    from: candles.length - visibleBars,
    to:   candles.length + 8,   // +8 = right offset padding
  });
}

// ── EMA Lines (20 / 50 / 200) ───────────────────────────────
function drawEMAs(candles, emas) {
  if (ema20Series)  { chart.removeSeries(ema20Series);  ema20Series  = null; }
  if (ema50Series)  { chart.removeSeries(ema50Series);  ema50Series  = null; }
  if (ema200Series) { chart.removeSeries(ema200Series); ema200Series = null; }

  ema20Series  = chart.addLineSeries({ color: 'rgba(0,230,118,0.7)',  lineWidth: 1,   priceLineVisible: false, lastValueVisible: false });
  ema50Series  = chart.addLineSeries({ color: 'rgba(255,213,79,0.6)', lineWidth: 1,   priceLineVisible: false, lastValueVisible: false });
  ema200Series = chart.addLineSeries({ color: 'rgba(255,68,68,0.6)',  lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });

  const toSeries = arr => candles
    .map((c, i) => arr[i] != null ? { time: c.time, value: arr[i] } : null)
    .filter(Boolean);

  ema20Series.setData(toSeries(emas.ema20));
  ema50Series.setData(toSeries(emas.ema50));
  ema200Series.setData(toSeries(emas.ema200));
}

// ── Live Price Line ──────────────────────────────────────────
// Draws a horizontal dashed price line at the current live price.
// Matches the price shown in the header ticker so the chart and
// the displayed price are always in sync.
function updateLivePriceLine(price, direction) {
  if (!candleSeries || !price) return;

  // Remove old line
  if (livePriceLine) {
    try { candleSeries.removePriceLine(livePriceLine); } catch (_) {}
    livePriceLine = null;
  }

  const color = direction === 'up' ? '#00e676' : direction === 'down' ? '#ff4444' : '#ffd54f';

  livePriceLine = candleSeries.createPriceLine({
    price,
    color,
    lineWidth:   1,
    lineStyle:   LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: true,
    title:       'LIVE',
  });
}

// ── Live Candle Update ───────────────────────────────────────
// Updates the last (current forming) candle with the live price
// so the chart never looks stale / disconnected from the header.
function updateLiveCandle(candles, livePrice) {
  if (!candleSeries || !candles?.length || !livePrice) return;

  const last = candles[candles.length - 1];
  // Update the current candle's close (and high/low if it breaches)
  const updatedCandle = {
    time:  last.time,
    open:  last.open,
    high:  Math.max(last.high, livePrice),
    low:   Math.min(last.low,  livePrice),
    close: livePrice,
  };
  candleSeries.update(updatedCandle);

  // Update volume bar for this candle too
  if (volumeSeries) {
    volumeSeries.update({
      time:  last.time,
      value: last.volume,
      color: livePrice >= last.open ? 'rgba(0,230,118,0.18)' : 'rgba(255,68,68,0.18)',
    });
  }
}

// ── Start Live Polling ───────────────────────────────────────
// Polls Bybit ticker every 3 seconds to keep the price line and
// current forming candle in sync with the live market price.
function startLiveTicker(symbol, candles) {
  if (liveTickerInterval) { clearInterval(liveTickerInterval); liveTickerInterval = null; }
  if (!symbol || !candles?.length) return;

  _currentSymbol = symbol;
  let prevPrice  = candles[candles.length - 1].close;

  async function tick() {
    try {
      const sym = symbol.toUpperCase() + 'USDT';
      const r   = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`);
      const d   = await r.json();
      if (d.retCode !== 0) return;
      const livePrice = parseFloat(d.result.list[0].lastPrice);
      if (!livePrice) return;

      const dir = livePrice > prevPrice ? 'up' : livePrice < prevPrice ? 'down' : 'flat';
      prevPrice = livePrice;

      updateLiveCandle(candles, livePrice);
      updateLivePriceLine(livePrice, dir);

      // Also update the header price display so everything stays in sync
      const priceEl = document.getElementById('h-price');
      if (priceEl) priceEl.textContent = `$${_formatPrice(livePrice)}`;
    } catch (_) { /* silent — chart just won't update this tick */ }
  }

  tick(); // immediate first tick
  liveTickerInterval = setInterval(tick, 3000);
}

function stopLiveTicker() {
  if (liveTickerInterval) { clearInterval(liveTickerInterval); liveTickerInterval = null; }
  if (livePriceLine && candleSeries) {
    try { candleSeries.removePriceLine(livePriceLine); } catch (_) {}
    livePriceLine = null;
  }
}

// ── Internal price formatter (mirrors app.js formatPrice) ───
function _formatPrice(p) {
  if (!p) return '0';
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1)    return p.toFixed(4);
  return p.toFixed(6);
}

// ── Master Render ─────────────────────────────────────────────
function renderAll(
  analysis,
  rawData,
  _chartContainer,
  _rsiContainer,
  _macdContainer,
  _volContainer,
  _fundingMini,
  _oiMini,
  _liqContainer
) {
  if (!analysis) return;
  loadCandles(analysis.candles);
  drawEMAs(analysis.candles, analysis.emas);

  // Draw initial live price line from ticker data
  const livePrice = rawData?.ticker?.price;
  if (livePrice) {
    const last  = analysis.candles[analysis.candles.length - 1];
    const dir   = livePrice >= last.close ? 'up' : 'down';
    updateLivePriceLine(livePrice, dir);
    updateLiveCandle(analysis.candles, livePrice);
  }

  // Start 3-second live polling for price + candle sync
  const symbol = rawData?.ticker ? window.__atlCurrentSymbol || '' : '';
  if (symbol) startLiveTicker(symbol, analysis.candles);
}

// ── Sub-panel stubs (kept so app.js imports don't break) ─────
function initRSIChart()       {}
function initMACDChart()      {}
function setupOverlayCanvas() {}
function redrawOverlay()      {}
function drawVolumeProfile()  {}
function drawFundingChart()   {}
function drawOIChart()        {}
function drawLiquidationBar() {}

export {
  initChart, initRSIChart, initMACDChart,
  setupOverlayCanvas, renderAll, redrawOverlay,
  drawVolumeProfile, drawFundingChart, drawOIChart, drawLiquidationBar,
  startLiveTicker, stopLiveTicker, updateLivePriceLine,
};
