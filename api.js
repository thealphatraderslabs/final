// ATL Ticker Analyzer — API Module
// Routing rules from API recon:
//   Bybit V5: primary for klines, OI, orderbook, funding, tickers (zero CORS, fastest)
//   FAPI: primary for fundingRate, premiumIndex, mark price (CORS-safe data endpoints)
//   SPOT: perfect 18/18, use for 24hr stats
//   CoinGecko: CORS-blocked — skip in browser, mark as unavailable

const API = {
  BYBIT:    'https://api.bybit.com/v5/market',
  FAPI:     'https://fapi.binance.com/fapi/v1',
  SPOT:     'https://api.binance.com/api/v3',
};

// ── Timeframe map ──────────────────────────────────────────
const TF_MAP = {
  '1m':  { bybit: '1',   fapi: '1m'  },
  '5m':  { bybit: '5',   fapi: '5m'  },
  '15m': { bybit: '15',  fapi: '15m' },
  '1h':  { bybit: '60',  fapi: '1h'  },
  '4h':  { bybit: '240', fapi: '4h'  },
  '1d':  { bybit: 'D',   fapi: '1d'  },
  '1w':  { bybit: 'W',   fapi: '1w'  },
};

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${url}`);
  return r.json();
}

// ── Klines ─────────────────────────────────────────────────
// Primary: Bybit /kline | Fallback: FAPI /klines
async function fetchKlines(symbol, interval, limit = 300) {
  const tf = TF_MAP[interval] || TF_MAP['1h'];
  const sym = symbol.toUpperCase() + 'USDT';

  try {
    const url = `${API.BYBIT}/kline?symbol=${sym}&interval=${tf.bybit}&limit=${limit}`;
    const d = await fetchJSON(url);
    if (d.retCode !== 0) throw new Error(d.retMsg);
    // Bybit returns [startTime, open, high, low, close, volume, turnover]
    // reversed (newest first) → reverse
    return d.result.list.reverse().map(c => ({
      time:   Math.floor(Number(c[0]) / 1000),
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  } catch (e) {
    console.warn('Bybit kline failed, falling back to FAPI:', e.message);
    const url = `${API.FAPI}/klines?symbol=${sym}&interval=${tf.fapi}&limit=${limit}`;
    const d = await fetchJSON(url);
    return d.map(c => ({
      time:   Math.floor(c[0] / 1000),
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  }
}

// ── Live Ticker (price + OI + funding bundled) ─────────────
// Primary: Bybit /tickers (linear) — OI + funding free
async function fetchTicker(symbol) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const url = `${API.BYBIT}/tickers?category=linear&symbol=${sym}`;
    const d = await fetchJSON(url);
    if (d.retCode !== 0) throw new Error(d.retMsg);
    const t = d.result.list[0];
    return {
      price:        parseFloat(t.lastPrice),
      price24h:     parseFloat(t.price24hPcnt) * 100,
      high24h:      parseFloat(t.highPrice24h),
      low24h:       parseFloat(t.lowPrice24h),
      volume24h:    parseFloat(t.volume24h),
      turnover24h:  parseFloat(t.turnover24h),
      openInterest: parseFloat(t.openInterest),
      fundingRate:  parseFloat(t.fundingRate) * 100,
      markPrice:    parseFloat(t.markPrice),
      indexPrice:   parseFloat(t.indexPrice),
      source:       'Bybit',
    };
  } catch (e) {
    console.warn('Bybit ticker failed, using FAPI:', e.message);
    const [premIdx, spot24] = await Promise.all([
      fetchJSON(`${API.FAPI}/premiumIndex?symbol=${sym}`),
      fetchJSON(`${API.SPOT}/ticker/24hr?symbol=${sym}`),
    ]);
    return {
      price:        parseFloat(premIdx.markPrice),
      price24h:     parseFloat(spot24.priceChangePercent),
      high24h:      parseFloat(spot24.highPrice),
      low24h:       parseFloat(spot24.lowPrice),
      volume24h:    parseFloat(spot24.volume),
      turnover24h:  parseFloat(spot24.quoteVolume),
      openInterest: null,
      fundingRate:  parseFloat(premIdx.lastFundingRate) * 100,
      markPrice:    parseFloat(premIdx.markPrice),
      indexPrice:   parseFloat(premIdx.indexPrice),
      source:       'FAPI+SPOT',
    };
  }
}

// ── Order Book ─────────────────────────────────────────────
// Primary: Bybit /orderbook (136ms) | Fallback: FAPI /depth
async function fetchOrderBook(symbol, depth = 50) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const url = `${API.BYBIT}/orderbook?category=linear&symbol=${sym}&limit=${depth}`;
    const d = await fetchJSON(url);
    if (d.retCode !== 0) throw new Error(d.retMsg);
    return {
      bids: d.result.b.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: d.result.a.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      source: 'Bybit',
    };
  } catch (e) {
    console.warn('Bybit OB failed, using FAPI:', e.message);
    const url = `${API.FAPI}/depth?symbol=${sym}&limit=${depth}`;
    const d = await fetchJSON(url);
    return {
      bids: d.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: d.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      source: 'FAPI',
    };
  }
}

// ── Open Interest History ──────────────────────────────────
// Primary: Bybit /open-interest (historical, no CORS) — unique advantage
async function fetchOIHistory(symbol, interval = '1h', limit = 48) {
  const sym = symbol.toUpperCase() + 'USDT';
  const bybitPeriod = { '5m':'5min','15m':'15min','1h':'1h','4h':'4h','1d':'1d','1w':'1w' };
  const period = bybitPeriod[interval] || '1h';
  try {
    const url = `${API.BYBIT}/open-interest?category=linear&symbol=${sym}&intervalTime=${period}&limit=${limit}`;
    const d = await fetchJSON(url);
    if (d.retCode !== 0) throw new Error(d.retMsg);
    return d.result.list.reverse().map(r => ({
      time: Math.floor(Number(r.timestamp) / 1000),
      oi:   parseFloat(r.openInterest),
    }));
  } catch (e) {
    console.warn('OI history unavailable:', e.message);
    return [];
  }
}

// ── Funding Rate History ───────────────────────────────────
// Primary: FAPI /fundingRate | Fallback: Bybit /funding/history
async function fetchFundingHistory(symbol, limit = 20) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const url = `${API.FAPI}/fundingRate?symbol=${sym}&limit=${limit}`;
    const d = await fetchJSON(url);
    return d.map(r => ({
      time: Math.floor(r.fundingTime / 1000),
      rate: parseFloat(r.fundingRate) * 100,
    })).reverse();
  } catch (e) {
    console.warn('FAPI funding failed, using Bybit:', e.message);
    const url = `${API.BYBIT}/funding/history?category=linear&symbol=${sym}&limit=${limit}`;
    const d = await fetchJSON(url);
    if (d.retCode !== 0) return [];
    return d.result.list.reverse().map(r => ({
      time: Math.floor(Number(r.execTime) / 1000),
      rate: parseFloat(r.fundingRate) * 100,
    }));
  }
}

// ── Mark / Index Spread ────────────────────────────────────
// FAPI /premiumIndex — all in one
async function fetchPremiumIndex(symbol) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const d = await fetchJSON(`${API.FAPI}/premiumIndex?symbol=${sym}`);
    return {
      markPrice:       parseFloat(d.markPrice),
      indexPrice:      parseFloat(d.indexPrice),
      lastFundingRate: parseFloat(d.lastFundingRate) * 100,
      nextFundingTime: d.nextFundingTime,
      spread:          ((parseFloat(d.markPrice) - parseFloat(d.indexPrice)) / parseFloat(d.indexPrice)) * 100,
    };
  } catch (e) {
    return null;
  }
}

// ── Implied Volatility ─────────────────────────────────────
// Bybit /historical-volatility — UNIQUE, only source
async function fetchImpliedVol(symbol) {
  const base = symbol.toUpperCase();
  if (base !== 'BTC' && base !== 'ETH') return null;
  try {
    const url = `${API.BYBIT}/historical-volatility?category=option&baseCoin=${base}&period=7`;
    const d = await fetchJSON(url);
    if (d.retCode !== 0) return null;
    const list = d.result;
    if (!list || !list.length) return null;
    return {
      iv7d:  parseFloat(list[0]?.value || 0),
      iv30d: parseFloat(list[list.length - 1]?.value || 0),
    };
  } catch (e) {
    return null;
  }
}

// ── Aggregate Trades (replaces historicalTrades which needs key) ──
async function fetchAggTrades(symbol, limit = 100) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const d = await fetchJSON(`${API.FAPI}/aggTrades?symbol=${sym}&limit=${limit}`);
    const buys  = d.filter(t => !t.m).reduce((s, t) => s + parseFloat(t.q), 0);
    const sells = d.filter(t =>  t.m).reduce((s, t) => s + parseFloat(t.q), 0);
    const total = buys + sells;
    return {
      buyRatio:  total > 0 ? buys / total : 0.5,
      sellRatio: total > 0 ? sells / total : 0.5,
      takerBias: total > 0 ? ((buys - sells) / total) * 100 : 0,
    };
  } catch (e) {
    return { buyRatio: 0.5, sellRatio: 0.5, takerBias: 0 };
  }
}

// ── Master fetch — all data for a symbol ──────────────────
async function fetchAllData(symbol, primaryTF = '1h') {
  const [
    ticker,
    klinesLTF,
    klinesMTF,
    klinesHTF,
    orderBook,
    oiHistory,
    fundingHist,
    premIndex,
    impliedVol,
    takerFlow,
  ] = await Promise.allSettled([
    fetchTicker(symbol),
    fetchKlines(symbol, '15m', 200),
    fetchKlines(symbol, primaryTF, 300),
    fetchKlines(symbol, '4h', 200),
    fetchOrderBook(symbol, 50),
    fetchOIHistory(symbol, '1h', 48),
    fetchFundingHistory(symbol, 20),
    fetchPremiumIndex(symbol),
    fetchImpliedVol(symbol),
    fetchAggTrades(symbol, 200),
  ]);

  return {
    ticker:      ticker.status      === 'fulfilled' ? ticker.value      : null,
    klinesLTF:   klinesLTF.status   === 'fulfilled' ? klinesLTF.value   : [],
    klinesMTF:   klinesMTF.status   === 'fulfilled' ? klinesMTF.value   : [],
    klinesHTF:   klinesHTF.status   === 'fulfilled' ? klinesHTF.value   : [],
    orderBook:   orderBook.status   === 'fulfilled' ? orderBook.value   : null,
    oiHistory:   oiHistory.status   === 'fulfilled' ? oiHistory.value   : [],
    fundingHist: fundingHist.status === 'fulfilled' ? fundingHist.value : [],
    premIndex:   premIndex.status   === 'fulfilled' ? premIndex.value   : null,
    impliedVol:  impliedVol.status  === 'fulfilled' ? impliedVol.value  : null,
    takerFlow:   takerFlow.status   === 'fulfilled' ? takerFlow.value   : null,
  };
}

export { fetchAllData, fetchKlines, fetchTicker, fetchOrderBook, fetchOIHistory, fetchFundingHistory };
