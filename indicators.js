// ATL Ticker Analyzer — Indicators Engine
// All calculations are pure math from OHLCV — no external indicator API needed.
// Logic derived from: ATL Launch Pad, ATL Consolidation Zone Map, LuxAlgo SMC, Liquidation Screener

// ═══════════════════════════════════════════════
//  PRIMITIVES
// ═══════════════════════════════════════════════

function highest(arr, field, len) {
  const slice = arr.slice(-len);
  return Math.max(...slice.map(c => c[field]));
}
function lowest(arr, field, len) {
  const slice = arr.slice(-len);
  return Math.min(...slice.map(c => c[field]));
}
function sma(values, len) {
  if (values.length < len) return null;
  const s = values.slice(-len);
  return s.reduce((a, b) => a + b, 0) / len;
}
function ema(values, len) {
  if (values.length === 0) return [];
  const k = 2 / (len + 1);
  const result = [];
  let prev = values[0];
  for (const v of values) {
    prev = v * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

// ═══════════════════════════════════════════════
//  ATR
// ═══════════════════════════════════════════════
function calcATR(candles, len = 14) {
  if (candles.length < 2) return [];
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  // RMA (Wilder smoothing)
  const result = new Array(candles.length).fill(null);
  let prev = trs.slice(0, len).reduce((a, b) => a + b, 0) / len;
  result[len] = prev;
  for (let i = len; i < trs.length; i++) {
    prev = (prev * (len - 1) + trs[i]) / len;
    result[i + 1] = prev;
  }
  return result;
}

// ═══════════════════════════════════════════════
//  RSI
// ═══════════════════════════════════════════════
function calcRSI(candles, len = 14) {
  const closes = candles.map(c => c.close);
  const result = new Array(candles.length).fill(null);
  if (closes.length < len + 1) return result;

  let gains = 0, losses = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / len, avgL = losses / len;
  result[len] = 100 - 100 / (1 + (avgL === 0 ? Infinity : avgG / avgL));

  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (len - 1) + Math.max(d, 0)) / len;
    avgL = (avgL * (len - 1) + Math.max(-d, 0)) / len;
    result[i] = 100 - 100 / (1 + (avgL === 0 ? Infinity : avgG / avgL));
  }
  return result;
}

// ═══════════════════════════════════════════════
//  MACD
// ═══════════════════════════════════════════════
function calcMACD(candles, fast = 12, slow = 26, signal = 9) {
  const closes = candles.map(c => c.close);
  const emaFast   = ema(closes, fast);
  const emaSlow   = ema(closes, slow);
  const macdLine  = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine, signal);
  const histogram  = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

// ═══════════════════════════════════════════════
//  EMA STACK
// ═══════════════════════════════════════════════
function calcEMAStack(candles) {
  const closes = candles.map(c => c.close);
  return {
    ema20:  ema(closes, 20),
    ema50:  ema(closes, 50),
    ema200: ema(closes, 200),
  };
}

// ═══════════════════════════════════════════════
//  SWING HIGHS / LOWS
//  Dual lookback: 5-bar local + 20-bar swing (from ATL CSA logic)
// ═══════════════════════════════════════════════
function detectSwings(candles, localLen = 5, swingLen = 20) {
  const pivotHighs = [], pivotLows = [];
  const n = candles.length;

  for (let i = swingLen; i < n - 2; i++) {
    const hi = candles[i].high;
    const lo = candles[i].low;
    let isHigh = true, isLow = true;

    for (let j = i - localLen; j <= i + 2; j++) {
      if (j === i) continue;
      if (j < 0 || j >= n) continue;
      if (candles[j].high >= hi) isHigh = false;
      if (candles[j].low  <= lo) isLow  = false;
    }

    if (isHigh) pivotHighs.push({ idx: i, price: hi, time: candles[i].time });
    if (isLow)  pivotLows.push({ idx: i, price: lo, time: candles[i].time });
  }
  return { pivotHighs, pivotLows };
}

// ═══════════════════════════════════════════════
//  MARKET STRUCTURE — BOS / CHoCH
//  Trend-state memory: BOS = continuation, CHoCH = reversal
//  Close-confirmed only (strict ICT-style)
// ═══════════════════════════════════════════════
function detectStructure(candles, pivotHighs, pivotLows) {
  const events = [];
  if (!pivotHighs.length || !pivotLows.length) return events;

  let trend = 'neutral'; // 'bull' | 'bear' | 'neutral'
  let lastSwingHigh = pivotHighs[0];
  let lastSwingLow  = pivotLows[0];

  const closes = candles.map(c => c.close);

  for (let i = 1; i < candles.length; i++) {
    const close = closes[i];

    // Detect swing high crosses
    const crossedHighs = pivotHighs.filter(ph =>
      ph.idx < i && !ph.crossed && close > ph.price
    );
    for (const ph of crossedHighs) {
      ph.crossed = true;
      const type = trend === 'bear' ? 'CHoCH' : 'BOS';
      events.push({ type, dir: 'bull', price: ph.price, idx: i, time: candles[i].time });
      trend = 'bull';
      lastSwingHigh = ph;
    }

    // Detect swing low crosses
    const crossedLows = pivotLows.filter(pl =>
      pl.idx < i && !pl.crossed && close < pl.price
    );
    for (const pl of crossedLows) {
      pl.crossed = true;
      const type = trend === 'bull' ? 'CHoCH' : 'BOS';
      events.push({ type, dir: 'bear', price: pl.price, idx: i, time: candles[i].time });
      trend = 'bear';
      lastSwingLow = pl;
    }
  }

  return { events, trend, lastSwingHigh, lastSwingLow };
}

// ═══════════════════════════════════════════════
//  ORDER BLOCKS
//  Last bearish candle before a bullish impulse (strict ICT)
//  Last bullish candle before a bearish impulse
//  ATR volatility filter: candle range > 0.3 × ATR
// ═══════════════════════════════════════════════
function detectOrderBlocks(candles, atrs, structureEvents, maxBlocks = 6) {
  const blocks = [];
  const n = candles.length;

  for (const ev of structureEvents) {
    if (!ev || ev.idx < 3) continue;
    const impulseIdx = ev.idx;

    if (ev.dir === 'bull') {
      // Find last bearish candle before impulse
      for (let i = impulseIdx - 1; i >= Math.max(0, impulseIdx - 15); i--) {
        const c = candles[i];
        const atr = atrs[i] || 1;
        if (c.close < c.open && (c.high - c.low) > 0.3 * atr) {
          blocks.push({
            type: 'demand', dir: 'bull',
            high: c.high, low: c.low, open: c.open, close: c.close,
            idx: i, time: c.time,
            state: 'fresh', tested: false,
            structureType: ev.type,
          });
          break;
        }
      }
    } else {
      // Find last bullish candle before bearish impulse
      for (let i = impulseIdx - 1; i >= Math.max(0, impulseIdx - 15); i--) {
        const c = candles[i];
        const atr = atrs[i] || 1;
        if (c.close > c.open && (c.high - c.low) > 0.3 * atr) {
          blocks.push({
            type: 'supply', dir: 'bear',
            high: c.high, low: c.low, open: c.open, close: c.close,
            idx: i, time: c.time,
            state: 'fresh', tested: false,
            structureType: ev.type,
          });
          break;
        }
      }
    }
  }

  // Update states based on current price action
  const lastClose = candles[candles.length - 1].close;
  for (const ob of blocks) {
    if (ob.state === 'fresh') {
      if (lastClose >= ob.low && lastClose <= ob.high) {
        ob.state = 'tested';
      } else if (
        (ob.dir === 'bull' && lastClose < ob.low) ||
        (ob.dir === 'bear' && lastClose > ob.high)
      ) {
        ob.state = 'mitigated';
      }
    }
  }

  // Return most recent, deduplicated blocks
  return blocks.slice(-maxBlocks * 2).slice(-maxBlocks);
}

// ═══════════════════════════════════════════════
//  FAIR VALUE GAPS
//  3-candle imbalance: candle[i].low > candle[i-2].high (bull)
//  candle[i].high < candle[i-2].low (bear)
// ═══════════════════════════════════════════════
function detectFVGs(candles, minGapPct = 0.05, maxFVGs = 8) {
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const prev2 = candles[i - 2];
    const curr  = candles[i];

    const bullFVG = curr.low > prev2.high;
    const bearFVG = curr.high < prev2.low;

    if (bullFVG) {
      const gapSize = ((curr.low - prev2.high) / prev2.high) * 100;
      if (gapSize >= minGapPct) {
        fvgs.push({
          dir: 'bull', top: curr.low, bottom: prev2.high,
          mid: (curr.low + prev2.high) / 2,
          idx: i - 1, time: candles[i - 1].time,
          filled: false, size: gapSize,
        });
      }
    }
    if (bearFVG) {
      const gapSize = ((prev2.low - curr.high) / prev2.low) * 100;
      if (gapSize >= minGapPct) {
        fvgs.push({
          dir: 'bear', top: prev2.low, bottom: curr.high,
          mid: (prev2.low + curr.high) / 2,
          idx: i - 1, time: candles[i - 1].time,
          filled: false, size: gapSize,
        });
      }
    }
  }

  // Mark filled FVGs
  const lastClose = candles[candles.length - 1]?.close || 0;
  for (const fvg of fvgs) {
    if (fvg.dir === 'bull' && lastClose < fvg.bottom) fvg.filled = true;
    if (fvg.dir === 'bear' && lastClose > fvg.top)    fvg.filled = true;
  }

  return fvgs.filter(f => !f.filled).slice(-maxFVGs);
}

// ═══════════════════════════════════════════════
//  PREMIUM / DISCOUNT ZONES
//  Range = swing high to swing low
//  Premium: top 25%, Discount: bottom 25%, Equilibrium: 40–60%
// ═══════════════════════════════════════════════
function calcPremiumDiscount(candles, lookback = 100) {
  const slice = candles.slice(-lookback);
  const rangeHigh = Math.max(...slice.map(c => c.high));
  const rangeLow  = Math.min(...slice.map(c => c.low));
  const range     = rangeHigh - rangeLow;

  if (range === 0) return null;

  const fib50  = rangeLow + range * 0.5;
  const fib618 = rangeLow + range * 0.618;
  const fib382 = rangeLow + range * 0.382;
  const fib705 = rangeLow + range * 0.705;
  const fib236 = rangeLow + range * 0.236;

  const lastClose = candles[candles.length - 1].close;
  const position  = (lastClose - rangeLow) / range; // 0 = at low, 1 = at high

  let zone;
  if (position >= 0.618)      zone = 'premium';
  else if (position <= 0.382) zone = 'discount';
  else                         zone = 'equilibrium';

  return {
    rangeHigh, rangeLow, range,
    fib50, fib618, fib382, fib705, fib236,
    position, zone,
    premiumStart:    fib618,
    discountStart:   fib382,
    equilTop:        fib618,
    equilBot:        fib382,
  };
}

// ═══════════════════════════════════════════════
//  LIQUIDITY ZONES
//  Equal highs / equal lows (clustered wick levels)
// ═══════════════════════════════════════════════
function detectLiquidityZones(candles, tolerance = 0.002, lookback = 100) {
  const slice = candles.slice(-lookback);
  const zones  = [];

  // Cluster highs
  const highs = slice.map(c => c.high);
  const lows  = slice.map(c => c.low);

  function cluster(arr, isHigh) {
    const result = [];
    for (let i = 0; i < arr.length; i++) {
      let matches = [arr[i]];
      for (let j = i + 1; j < arr.length; j++) {
        if (Math.abs(arr[j] - arr[i]) / arr[i] <= tolerance) matches.push(arr[j]);
      }
      if (matches.length >= 2) {
        const avg = matches.reduce((a, b) => a + b, 0) / matches.length;
        result.push({
          price: avg,
          count: matches.length,
          type: isHigh ? 'eqh' : 'eql',
          label: isHigh ? 'Equal Highs' : 'Equal Lows',
          dir: isHigh ? 'bear' : 'bull', // EQH = bearish liquidity above, EQL = bullish below
        });
      }
    }
    return result;
  }

  const eqhs = cluster(highs, true);
  const eqls = cluster(lows, false);

  // Deduplicate
  const seen = new Set();
  for (const z of [...eqhs, ...eqls]) {
    const key = z.price.toFixed(2);
    if (!seen.has(key)) {
      seen.add(key);
      zones.push(z);
    }
  }

  return zones.sort((a, b) => b.price - a.price).slice(0, 6);
}

// ═══════════════════════════════════════════════
//  LIQUIDATION LEVELS
//  From Liquidation Screener Pine Script:
//  Uses swing high/low + leverage multipliers
// ═══════════════════════════════════════════════
function calcLiquidationLevels(candles, lookback = 40) {
  const slice = candles.slice(-lookback);
  const swingHigh = Math.max(...slice.map(c => c.high));
  const swingLow  = Math.min(...slice.map(c => c.low));

  // Short liquidations (above swing high — bulls get squeezed)
  const shortLiqs = [
    { label: '100×', price: swingHigh * 1.01, leverage: '100x' },
    { label: '50×',  price: swingHigh * 1.02, leverage: '50x'  },
    { label: '25×',  price: swingHigh * 1.04, leverage: '25x'  },
    { label: '10×',  price: swingHigh * 1.10, leverage: '10x'  },
    { label: '5×',   price: swingHigh * 1.20, leverage: '5x'   },
    { label: '3×',   price: swingHigh * 1.33, leverage: '3x'   },
    { label: '2×',   price: swingHigh * 1.50, leverage: '2x'   },
  ];

  // Long liquidations (below swing low — bears get squeezed)
  const longLiqs = [
    { label: '100×', price: swingLow * 0.99, leverage: '100x' },
    { label: '50×',  price: swingLow * 0.98, leverage: '50x'  },
    { label: '25×',  price: swingLow * 0.96, leverage: '25x'  },
    { label: '10×',  price: swingLow * 0.90, leverage: '10x'  },
    { label: '5×',   price: swingLow * 0.80, leverage: '5x'   },
    { label: '3×',   price: swingLow * 0.67, leverage: '3x'   },
    { label: '2×',   price: swingLow * 0.50, leverage: '2x'   },
  ];

  return { swingHigh, swingLow, shortLiqs, longLiqs };
}

// ═══════════════════════════════════════════════
//  SUPPORT / RESISTANCE
//  Pivot-point clustering with volume-at-price proxy
// ═══════════════════════════════════════════════
function detectSR(candles, pivotHighs, pivotLows, tolerance = 0.005, maxLevels = 8) {
  const levels = [];

  for (const ph of pivotHighs.slice(-20)) {
    levels.push({ price: ph.price, type: 'resistance', strength: 1 });
  }
  for (const pl of pivotLows.slice(-20)) {
    levels.push({ price: pl.price, type: 'support', strength: 1 });
  }

  // Merge nearby levels
  const merged = [];
  const used = new Set();
  for (let i = 0; i < levels.length; i++) {
    if (used.has(i)) continue;
    let group = [levels[i]];
    for (let j = i + 1; j < levels.length; j++) {
      if (!used.has(j) && Math.abs(levels[j].price - levels[i].price) / levels[i].price <= tolerance) {
        group.push(levels[j]);
        used.add(j);
      }
    }
    used.add(i);
    const avgPrice = group.reduce((a, b) => a + b.price, 0) / group.length;
    const types    = group.map(g => g.type);
    const isSupply = types.filter(t => t === 'resistance').length > types.length / 2;
    merged.push({
      price:    avgPrice,
      type:     isSupply ? 'resistance' : 'support',
      strength: group.length, // touch count
    });
  }

  return merged.sort((a, b) => b.strength - a.strength).slice(0, maxLevels);
}

// ═══════════════════════════════════════════════
//  VOLUME PROFILE (approximation from OHLCV)
// ═══════════════════════════════════════════════
function calcVolumeProfile(candles, bins = 24, lookback = 100) {
  const slice   = candles.slice(-lookback);
  const high    = Math.max(...slice.map(c => c.high));
  const low     = Math.min(...slice.map(c => c.low));
  const range   = high - low;
  if (range === 0) return [];

  const binSize = range / bins;
  const profile = Array.from({ length: bins }, (_, i) => ({
    price: low + (i + 0.5) * binSize,
    low:   low + i * binSize,
    high:  low + (i + 1) * binSize,
    vol:   0,
  }));

  for (const c of slice) {
    const mid  = (c.high + c.low) / 2;
    const bin  = Math.floor((mid - low) / binSize);
    const idx  = Math.min(Math.max(bin, 0), bins - 1);
    profile[idx].vol += c.volume;
  }

  const maxVol = Math.max(...profile.map(p => p.vol));
  for (const p of profile) p.volPct = maxVol > 0 ? p.vol / maxVol : 0;

  // Find POC (Point of Control)
  const poc = profile.reduce((best, p) => p.vol > best.vol ? p : best, profile[0]);
  poc.isPOC = true;

  return profile;
}

// ═══════════════════════════════════════════════
//  ORDER BOOK ANALYSIS
// ═══════════════════════════════════════════════
function analyzeOrderBook(orderBook, currentPrice) {
  if (!orderBook) return null;

  const { bids, asks } = orderBook;

  const bidVol = bids.reduce((s, [, q]) => s + q, 0);
  const askVol = asks.reduce((s, [, q]) => s + q, 0);
  const total  = bidVol + askVol;

  const bidAskRatio = total > 0 ? bidVol / total : 0.5;

  // Find large walls (top 10% by size)
  const allSizes = [...bids, ...asks].map(([, q]) => q).sort((a, b) => b - a);
  const wallThreshold = allSizes[Math.floor(allSizes.length * 0.1)] || 0;

  const bidWalls = bids.filter(([, q]) => q >= wallThreshold).map(([p, q]) => ({ price: p, size: q, side: 'bid' }));
  const askWalls = asks.filter(([, q]) => q >= wallThreshold).map(([p, q]) => ({ price: p, size: q, side: 'ask' }));

  // Imbalance: ratio of bids:asks within 1% of price
  const nearBids = bids.filter(([p]) => p >= currentPrice * 0.99);
  const nearAsks = asks.filter(([p]) => p <= currentPrice * 1.01);
  const nearBidVol = nearBids.reduce((s, [, q]) => s + q, 0);
  const nearAskVol = nearAsks.reduce((s, [, q]) => s + q, 0);

  return {
    bidVol, askVol, total,
    bidAskRatio,
    bidWalls, askWalls,
    nearBidVol, nearAskVol,
    nearImbalance: (nearBidVol + nearAskVol) > 0 ? nearBidVol / (nearBidVol + nearAskVol) : 0.5,
    bias: bidAskRatio > 0.55 ? 'bullish' : bidAskRatio < 0.45 ? 'bearish' : 'neutral',
  };
}

// ═══════════════════════════════════════════════
//  DIVERGENCE DETECTION (RSI)
// ═══════════════════════════════════════════════
function detectDivergence(candles, rsiValues, lookback = 30) {
  const slice     = candles.slice(-lookback);
  const rsiSlice  = rsiValues.slice(-lookback);
  const divergences = [];

  for (let i = 5; i < slice.length - 1; i++) {
    const priceNow  = slice[i].close;
    const rsiNow    = rsiSlice[i];
    if (rsiNow === null) continue;

    // Bullish divergence: price lower low, RSI higher low
    for (let j = i - 10; j < i - 3; j++) {
      if (j < 0) continue;
      const pricePrev = slice[j].close;
      const rsiPrev   = rsiSlice[j];
      if (rsiPrev === null) continue;

      if (priceNow < pricePrev && rsiNow > rsiPrev + 2) {
        divergences.push({ type: 'bullish', idx: i, rsiNow, rsiPrev, priceNow, pricePrev });
        break;
      }
      if (priceNow > pricePrev && rsiNow < rsiPrev - 2) {
        divergences.push({ type: 'bearish', idx: i, rsiNow, rsiPrev, priceNow, pricePrev });
        break;
      }
    }
  }

  return divergences.slice(-3);
}

// ═══════════════════════════════════════════════
//  MASTER ANALYSIS RUNNER
// ═══════════════════════════════════════════════
function runAnalysis(data) {
  const { klinesLTF, klinesMTF, klinesHTF, ticker, orderBook } = data;

  if (!klinesMTF || klinesMTF.length < 50) return null;

  // Core calcs on MTF (primary timeframe)
  const atrs    = calcATR(klinesMTF, 14);
  const rsi     = calcRSI(klinesMTF, 14);
  const macd    = calcMACD(klinesMTF);
  const emas    = calcEMAStack(klinesMTF);
  const { pivotHighs, pivotLows } = detectSwings(klinesMTF, 5, 20);
  const structure = detectStructure(klinesMTF, pivotHighs.map(p => ({...p})), pivotLows.map(p => ({...p})));
  const orderBlocks = detectOrderBlocks(klinesMTF, atrs, structure.events || [], 6);
  const fvgs        = detectFVGs(klinesMTF, 0.03, 8);
  const premDisc    = calcPremiumDiscount(klinesMTF, 100);
  const liqZones    = detectLiquidityZones(klinesMTF, 0.003, 100);
  const srLevels    = detectSR(klinesMTF, pivotHighs, pivotLows);
  const volProfile  = calcVolumeProfile(klinesMTF, 24, 100);
  const divs        = detectDivergence(klinesMTF, rsi, 40);

  // Liquidation levels on HTF for bigger range
  const liqLevels = klinesHTF.length > 40
    ? calcLiquidationLevels(klinesHTF, 40)
    : calcLiquidationLevels(klinesMTF, 40);

  // HTF structure for bias
  let htfStructure = null;
  if (klinesHTF.length > 50) {
    const htfSwings  = detectSwings(klinesHTF, 5, 20);
    htfStructure = detectStructure(klinesHTF, htfSwings.pivotHighs.map(p => ({...p})), htfSwings.pivotLows.map(p => ({...p})));
  }

  // OB analysis
  const obAnalysis = analyzeOrderBook(orderBook, ticker?.price || klinesMTF[klinesMTF.length - 1].close);

  const lastCandle = klinesMTF[klinesMTF.length - 1];
  const lastATR    = atrs[atrs.length - 1] || 0;
  const lastRSI    = rsi[rsi.length - 1];
  const lastMACD   = {
    line:      macd.macdLine[macd.macdLine.length - 1],
    signal:    macd.signalLine[macd.signalLine.length - 1],
    histogram: macd.histogram[macd.histogram.length - 1],
  };
  const lastEMAs = {
    ema20:  emas.ema20[emas.ema20.length - 1],
    ema50:  emas.ema50[emas.ema50.length - 1],
    ema200: emas.ema200[emas.ema200.length - 1],
  };

  return {
    // Raw
    candles: klinesMTF,
    candlesLTF: klinesLTF,
    candlesHTF: klinesHTF,
    // Indicators
    atrs, rsi, macd, emas,
    // Levels
    pivotHighs, pivotLows,
    structure,
    htfStructure,
    orderBlocks,
    fvgs,
    premDisc,
    liqZones,
    srLevels,
    volProfile,
    divs,
    liqLevels,
    obAnalysis,
    // Current values
    lastCandle,
    lastATR,
    lastRSI,
    lastMACD,
    lastEMAs,
    price: ticker?.price || lastCandle.close,
  };
}

export {
  calcATR, calcRSI, calcMACD, calcEMAStack,
  detectSwings, detectStructure, detectOrderBlocks, detectFVGs,
  calcPremiumDiscount, detectLiquidityZones, calcLiquidationLevels,
  detectSR, calcVolumeProfile, analyzeOrderBook, detectDivergence,
  runAnalysis,
};
