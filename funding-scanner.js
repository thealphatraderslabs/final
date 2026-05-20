// ATL · Funding Rate Scanner
// Phase 3 — scans all USDT perp pairs on Bybit + Binance
// Filters: fundingRate >= +0.05% (positive imbalance / bearish)
//          fundingRate <= -0.05% (negative imbalance / bullish)
// Common scan: pairs qualifying on BOTH exchanges simultaneously

const BYBIT_BASE = 'https://api.bybit.com/v5/market';
const FAPI_BASE  = 'https://fapi.binance.com/fapi/v1';

const THRESHOLD_POS =  0.0005;  // +0.05% in raw decimal
const THRESHOLD_NEG = -0.0005;  // -0.05% in raw decimal

const BATCH_SIZE  = 30;   // funding is lightweight — larger batches fine
const BATCH_DELAY = 120;  // ms between batches

let scanAborted  = false;
let scanRunning  = false;

// ── Utils ──────────────────────────────────────────────────────
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// ── Pair fetching ──────────────────────────────────────────────
async function fetchBybitPairs() {
  const d = await fetchJSON(`${BYBIT_BASE}/instruments-info?category=linear&limit=1000`);
  if (d.retCode !== 0) throw new Error(d.retMsg);
  return d.result.list
    .filter(s => s.status === 'Trading' && s.quoteCoin === 'USDT' && s.contractType === 'LinearPerpetual')
    .map(s => s.symbol.replace('USDT', ''));
}

async function fetchBinancePairs() {
  const d = await fetchJSON(`${FAPI_BASE}/exchangeInfo`);
  return d.symbols
    .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL')
    .map(s => s.baseAsset);
}

// ── Single funding fetch ───────────────────────────────────────
// Bybit: /tickers?category=linear — returns fundingRate + nextFundingTime in one call
async function fetchBybitFunding(symbol) {
  const sym = symbol.toUpperCase() + 'USDT';
  const d = await fetchJSON(`${BYBIT_BASE}/tickers?category=linear&symbol=${sym}`);
  if (d.retCode !== 0) throw new Error(d.retMsg);
  const t = d.result.list[0];
  return {
    rate:            parseFloat(t.fundingRate),
    nextFundingTime: parseInt(t.nextFundingTime),
    price:           parseFloat(t.lastPrice),
    markPrice:       parseFloat(t.markPrice),
  };
}

// Binance FAPI: /premiumIndex — fundingRate + nextFundingTime
async function fetchBinanceFunding(symbol) {
  const sym = symbol.toUpperCase() + 'USDT';
  const d = await fetchJSON(`${FAPI_BASE}/premiumIndex?symbol=${sym}`);
  return {
    rate:            parseFloat(d.lastFundingRate),
    nextFundingTime: parseInt(d.nextFundingTime),
    price:           parseFloat(d.markPrice),
    markPrice:       parseFloat(d.markPrice),
  };
}

// ── Batch processor ────────────────────────────────────────────
async function processBatch(symbols, exchange, onResult, onProgress, doneOffset, totalPairs) {
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    if (scanAborted) return;
    const batch = symbols.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async sym => {
        const data = exchange === 'bybit'
          ? await fetchBybitFunding(sym)
          : await fetchBinanceFunding(sym);
        return { symbol: sym, exchange, ...data };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        const item = r.value;
        const rate = item.rate;
        if (rate >= THRESHOLD_POS || rate <= THRESHOLD_NEG) {
          onResult(item);
        }
      }
    }

    const done = Math.min(doneOffset + i + BATCH_SIZE, totalPairs);
    onProgress({ done, total: totalPairs, msg: `Scanning ${exchange === 'bybit' ? 'Bybit' : 'Binance'}… ${done}/${totalPairs}` });

    if (i + BATCH_SIZE < symbols.length) await sleep(BATCH_DELAY);
  }
}

// ── Single exchange scan ───────────────────────────────────────
export async function runFundingScan({ exchange, onProgress, onResult, onDone, onError }) {
  if (scanRunning) return;
  scanRunning = true;
  scanAborted = false;

  const results = [];

  try {
    onProgress({ done: 0, total: 0, msg: 'Fetching pairs…' });

    const pairs = exchange === 'bybit'
      ? await fetchBybitPairs()
      : await fetchBinancePairs();

    const total = pairs.length;
    onProgress({ done: 0, total, msg: `${total} pairs found — scanning…` });

    await processBatch(
      pairs,
      exchange,
      item => { results.push(item); onResult(item); },
      onProgress,
      0,
      total
    );

    // Sort: most extreme first (by absolute rate)
    results.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate));

    onDone({ results, total, aborted: scanAborted });
  } catch (e) {
    onError(e.message);
  } finally {
    scanRunning = false;
  }
}

// ── Common scan — both exchanges, find overlapping pairs ───────
export async function runFundingCommonScan({ onProgress, onResult, onDone, onError }) {
  if (scanRunning) return;
  scanRunning = true;
  scanAborted = false;

  try {
    onProgress({ done: 0, total: 0, msg: 'Fetching pairs from both exchanges…' });

    const [bybitPairs, binancePairs] = await Promise.all([
      fetchBybitPairs(),
      fetchBinancePairs(),
    ]);

    // Intersection — pairs on both exchanges
    const binanceSet = new Set(binancePairs.map(s => s.toUpperCase()));
    const common = bybitPairs.filter(s => binanceSet.has(s.toUpperCase()));

    const total = common.length * 2; // fetch from both exchanges
    let done = 0;

    onProgress({ done: 0, total, msg: `${common.length} common pairs — scanning both exchanges…` });

    // Fetch both exchanges in parallel batches
    const bybitResults   = new Map();
    const binanceResults = new Map();

    const bybitBatches   = [];
    const binanceBatches = [];

    for (let i = 0; i < common.length; i += BATCH_SIZE) {
      if (scanAborted) break;
      const batch = common.slice(i, i + BATCH_SIZE);

      const [bRes, nRes] = await Promise.all([
        Promise.allSettled(batch.map(async sym => {
          const d = await fetchBybitFunding(sym);
          return { symbol: sym, ...d };
        })),
        Promise.allSettled(batch.map(async sym => {
          const d = await fetchBinanceFunding(sym);
          return { symbol: sym, ...d };
        })),
      ]);

      bRes.forEach(r => { if (r.status === 'fulfilled') bybitResults.set(r.value.symbol, r.value); });
      nRes.forEach(r => { if (r.status === 'fulfilled') binanceResults.set(r.value.symbol, r.value); });

      done = Math.min(done + batch.length * 2, total);
      onProgress({ done, total, msg: `Scanning… ${Math.round(done / total * 100)}%` });

      if (i + BATCH_SIZE < common.length) await sleep(BATCH_DELAY);
    }

    // Build common results — pair must qualify on BOTH exchanges (same direction)
    const qualified = [];
    for (const sym of common) {
      if (scanAborted) break;
      const bybit   = bybitResults.get(sym);
      const binance = binanceResults.get(sym);
      if (!bybit || !binance) continue;

      const br = bybit.rate;
      const nr = binance.rate;

      // Both positive imbalance
      const bothPos = br >= THRESHOLD_POS && nr >= THRESHOLD_POS;
      // Both negative imbalance
      const bothNeg = br <= THRESHOLD_NEG && nr <= THRESHOLD_NEG;

      if (bothPos || bothNeg) {
        const item = {
          symbol:         sym,
          bybitRate:      br,
          binanceRate:    nr,
          bybitPrice:     bybit.price,
          binancePrice:   binance.price,
          bybitNextTime:  bybit.nextFundingTime,
          binanceNextTime:binance.nextFundingTime,
          direction:      bothPos ? 'positive' : 'negative',
          // Average rate for sorting
          avgRate:        (br + nr) / 2,
        };
        qualified.push(item);
        onResult(item);
      }
    }

    // Sort by absolute average rate
    qualified.sort((a, b) => Math.abs(b.avgRate) - Math.abs(a.avgRate));
    onDone({ results: qualified, total: common.length, aborted: scanAborted });

  } catch (e) {
    onError(e.message);
  } finally {
    scanRunning = false;
  }
}

export function abortFundingScan() {
  scanAborted = true;
}

// ── Helpers ────────────────────────────────────────────────────
export function formatFundingRate(rate) {
  // rate is raw decimal e.g. 0.0005 → display as 0.0500%
  return (rate * 100).toFixed(4) + '%';
}

export function fundingDirection(rate) {
  if (rate >= THRESHOLD_POS) return { label: 'POSITIVE', color: '#ff4444', bg: 'rgba(255,68,68,0.08)', desc: 'Longs paying shorts' };
  if (rate <= THRESHOLD_NEG) return { label: 'NEGATIVE', color: '#00e676', bg: 'rgba(0,230,118,0.08)', desc: 'Shorts paying longs' };
  return { label: 'NEUTRAL', color: '#5a6470', bg: 'transparent', desc: 'Balanced' };
}

export function timeToFunding(nextFundingTime) {
  if (!nextFundingTime) return '—';
  const diff = nextFundingTime - Date.now();
  if (diff <= 0) return 'Imminent';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
