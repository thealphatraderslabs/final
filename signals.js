// ATL Ticker Analyzer — Signal & Setup Engine
// Generates institutional-grade trade setups with full confluence reasoning

// ═══════════════════════════════════════════════
//  CONFLUENCE SCORING ENGINE
//  Each factor scores -2 to +2, sum = bias score
// ═══════════════════════════════════════════════

function scoreMarketStructure(analysis) {
  const { structure, htfStructure } = analysis;
  let score = 0, reasons = [];

  if (!structure) return { score: 0, reasons: ['Structure data unavailable'] };

  const mtfTrend = structure.trend;
  const htfTrend = htfStructure?.trend;

  if (mtfTrend === 'bull') {
    score += 2;
    reasons.push('MTF market structure is bullish — BOS confirmed to the upside');
  } else if (mtfTrend === 'bear') {
    score -= 2;
    reasons.push('MTF market structure is bearish — BOS confirmed to the downside');
  }

  if (htfTrend === 'bull' && mtfTrend === 'bull') {
    score += 1;
    reasons.push('HTF trend aligned: 4H + primary TF both bullish — high probability continuation');
  } else if (htfTrend === 'bear' && mtfTrend === 'bear') {
    score -= 1;
    reasons.push('HTF trend aligned: 4H + primary TF both bearish — high probability continuation');
  } else if (htfTrend && htfTrend !== mtfTrend) {
    reasons.push(`Caution: HTF ${htfTrend} vs MTF ${mtfTrend} — structure conflict, counter-trend move possible`);
  }

  const recentEvents = structure.events?.slice(-3) || [];
  const lastEvent    = recentEvents[recentEvents.length - 1];
  if (lastEvent?.type === 'CHoCH') {
    reasons.push(`CHoCH detected at $${lastEvent.price.toFixed(2)} — possible trend reversal in progress`);
  }

  return { score, reasons };
}

function scoreOrderBlocks(analysis) {
  const { orderBlocks, price } = analysis;
  let score = 0, reasons = [], nearestOB = null;

  if (!orderBlocks.length) return { score: 0, reasons: ['No valid order blocks detected'], nearestOB };

  const freshOBs  = orderBlocks.filter(ob => ob.state === 'fresh');
  const demandOBs = freshOBs.filter(ob => ob.type === 'demand').sort((a, b) => b.low - a.low);
  const supplyOBs = freshOBs.filter(ob => ob.type === 'supply').sort((a, b) => a.high - b.high);

  for (const ob of demandOBs) {
    const distPct = (price - ob.high) / price * 100;
    if (distPct >= 0 && distPct < 3) {
      score += 2; nearestOB = ob;
      reasons.push(`Price is ${distPct.toFixed(1)}% above fresh demand OB at $${ob.low.toFixed(2)}–$${ob.high.toFixed(2)} (${ob.structureType} structure origin)`);
      break;
    }
    if (distPct < 0 && distPct > -1) {
      score += 1; nearestOB = ob;
      reasons.push(`Price testing demand OB at $${ob.low.toFixed(2)}–$${ob.high.toFixed(2)} — key reversal zone`);
      break;
    }
  }

  for (const ob of supplyOBs) {
    const distPct = (ob.low - price) / price * 100;
    if (distPct >= 0 && distPct < 3) {
      score -= 2; nearestOB = ob;
      reasons.push(`Price approaching fresh supply OB at $${ob.low.toFixed(2)}–$${ob.high.toFixed(2)} — expect rejection`);
      break;
    }
    if (distPct < 0 && distPct > -1) {
      score -= 1; nearestOB = ob;
      reasons.push(`Price inside supply OB at $${ob.low.toFixed(2)}–$${ob.high.toFixed(2)} — bearish pressure zone`);
      break;
    }
  }

  if (!nearestOB) {
    reasons.push(`${freshOBs.length} fresh OBs identified — price not in proximity of any zone currently`);
  }

  return { score, reasons, nearestOB };
}

function scoreFVGs(analysis) {
  const { fvgs, price } = analysis;
  let score = 0, reasons = [];

  if (!fvgs.length) return { score: 0, reasons: ['No active FVGs detected'] };

  const nearFVGs = fvgs.filter(f => {
    const nearBot = Math.abs(price - f.bottom) / price < 0.05;
    const nearTop = Math.abs(price - f.top) / price < 0.05;
    return nearBot || nearTop || (price >= f.bottom && price <= f.top);
  });

  for (const fvg of nearFVGs) {
    if (fvg.dir === 'bull') {
      score += 1;
      reasons.push(`Bullish FVG at $${fvg.bottom.toFixed(2)}–$${fvg.top.toFixed(2)} (${fvg.size.toFixed(2)}% gap) — magnet for price`);
    } else {
      score -= 1;
      reasons.push(`Bearish FVG at $${fvg.bottom.toFixed(2)}–$${fvg.top.toFixed(2)} (${fvg.size.toFixed(2)}% gap) — overhead resistance`);
    }
  }

  if (!nearFVGs.length) {
    reasons.push(`${fvgs.length} active FVGs away from current price — monitoring for retest`);
  }

  return { score, reasons };
}

function scorePremiumDiscount(analysis) {
  const { premDisc } = analysis;
  if (!premDisc) return { score: 0, reasons: ['Premium/discount calculation unavailable'] };

  let score = 0, reasons = [];
  const { zone, position, fib50, rangeHigh, rangeLow } = premDisc;
  const pct = (position * 100).toFixed(1);

  if (zone === 'discount') {
    score += 2;
    reasons.push(`Price is in DISCOUNT zone (${pct}% of range) — below equilibrium, favorable for longs near demand`);
    reasons.push(`Fibonacci 38.2% at $${premDisc.fib382.toFixed(2)} is key equilibrium entry trigger`);
  } else if (zone === 'premium') {
    score -= 2;
    reasons.push(`Price is in PREMIUM zone (${pct}% of range) — above equilibrium, extended for longs, favorable for shorts`);
    reasons.push(`Fibonacci 61.8% at $${premDisc.fib618.toFixed(2)} marks the premium boundary`);
  } else {
    reasons.push(`Price is at EQUILIBRIUM (${pct}% of range) — $${fib50.toFixed(2)} is the 50% midpoint, direction unclear`);
  }

  return { score, reasons };
}

function scoreRSI(analysis) {
  const { lastRSI, divs } = analysis;
  let score = 0, reasons = [];

  if (lastRSI === null) return { score: 0, reasons: ['RSI insufficient data'] };

  if (lastRSI < 30) {
    score += 2;
    reasons.push(`RSI oversold at ${lastRSI.toFixed(1)} — historically high-probability bounce zone, watch for reversal candle`);
  } else if (lastRSI > 70) {
    score -= 2;
    reasons.push(`RSI overbought at ${lastRSI.toFixed(1)} — momentum stretched, risk of mean-reversion pullback`);
  } else if (lastRSI < 45) {
    score += 0.5;
    reasons.push(`RSI at ${lastRSI.toFixed(1)} — bearish territory but not oversold, momentum weak`);
  } else if (lastRSI > 55) {
    score -= 0.5;
    reasons.push(`RSI at ${lastRSI.toFixed(1)} — bullish territory, buyers in control`);
  } else {
    reasons.push(`RSI neutral at ${lastRSI.toFixed(1)} — no directional edge from momentum alone`);
  }

  const recentDiv = divs.slice(-1)[0];
  if (recentDiv) {
    if (recentDiv.type === 'bullish') {
      score += 1.5;
      reasons.push(`Bullish RSI divergence: price made lower low but RSI made higher low — hidden buying pressure, high-quality reversal signal`);
    } else {
      score -= 1.5;
      reasons.push(`Bearish RSI divergence: price made higher high but RSI made lower high — hidden selling pressure, trend exhaustion warning`);
    }
  }

  return { score, reasons };
}

function scoreMACD(analysis) {
  const { lastMACD } = analysis;
  let score = 0, reasons = [];

  if (!lastMACD.line) return { score: 0, reasons: ['MACD insufficient data'] };

  const { line, signal, histogram } = lastMACD;

  if (line > signal && line > 0) {
    score += 1.5;
    reasons.push(`MACD bullish: line above signal above zero — strong uptrend confirmation`);
  } else if (line > signal && line < 0) {
    score += 0.5;
    reasons.push(`MACD bullish crossover below zero — early recovery signal, watch for zero-line cross`);
  } else if (line < signal && line < 0) {
    score -= 1.5;
    reasons.push(`MACD bearish: line below signal below zero — downtrend confirmed`);
  } else if (line < signal && line > 0) {
    score -= 0.5;
    reasons.push(`MACD bearish crossover above zero — momentum weakening in uptrend`);
  }

  if (Math.abs(histogram) > 0 && histogram > 0) {
    reasons.push(`Histogram expanding bullish — buying momentum accelerating`);
  } else if (Math.abs(histogram) > 0 && histogram < 0) {
    reasons.push(`Histogram expanding bearish — selling momentum accelerating`);
  }

  return { score, reasons };
}

function scoreEMAStack(analysis) {
  const { lastEMAs, price } = analysis;
  let score = 0, reasons = [];

  const { ema20, ema50, ema200 } = lastEMAs;
  if (!ema20 || !ema200) return { score: 0, reasons: ['EMA data insufficient'] };

  const above200  = price > ema200;
  const above50   = price > ema50;
  const above20   = price > ema20;
  const stackBull = ema20 > ema50 && ema50 > ema200;
  const stackBear = ema20 < ema50 && ema50 < ema200;

  if (stackBull && above200) {
    score += 2;
    reasons.push(`Perfect bullish EMA stack: 20 > 50 > 200, price above all — textbook uptrend, dips to 20 EMA ($${ema20.toFixed(2)}) are buy opportunities`);
  } else if (stackBear && !above200) {
    score -= 2;
    reasons.push(`Perfect bearish EMA stack: 20 < 50 < 200, price below all — textbook downtrend, rallies to 20 EMA ($${ema20.toFixed(2)}) are sell opportunities`);
  } else if (above200 && !above50) {
    score += 0.5;
    reasons.push(`Price above 200 EMA but below 50 EMA — pullback within broader uptrend, watch for bounce at 200 EMA ($${ema200.toFixed(2)})`);
  } else if (!above200 && above50) {
    score -= 0.5;
    reasons.push(`Price below 200 EMA but above 50 EMA — potential dead-cat bounce, 200 EMA at $${ema200.toFixed(2)} is key resistance`);
  }

  const distFrom200 = ((price - ema200) / ema200 * 100).toFixed(1);
  reasons.push(`Distance from 200 EMA: ${distFrom200}% — ${Math.abs(parseFloat(distFrom200)) > 20 ? 'extended, mean reversion risk' : 'within normal range'}`);

  return { score, reasons };
}

function scoreDerivatives(data, analysis) {
  const { ticker, oiHistory, fundingHist, takerFlow } = data;
  let score = 0, reasons = [];

  const fr = ticker?.fundingRate;
  if (fr !== null && fr !== undefined) {
    if (fr < -0.05) {
      score += 1.5;
      reasons.push(`Funding rate strongly negative (${fr.toFixed(3)}%) — shorts paying longs, leveraged short squeeze risk is HIGH`);
    } else if (fr < -0.01) {
      score += 0.5;
      reasons.push(`Funding rate negative (${fr.toFixed(3)}%) — mild short bias in derivatives, slight support for longs`);
    } else if (fr > 0.1) {
      score -= 1.5;
      reasons.push(`Funding rate very high (${fr.toFixed(3)}%) — excessive longs paying shorts, overheated — long squeeze risk`);
    } else if (fr > 0.03) {
      score -= 0.5;
      reasons.push(`Funding rate elevated (${fr.toFixed(3)}%) — longs dominant, mild caution for overbought conditions`);
    } else {
      reasons.push(`Funding rate neutral (${fr.toFixed(3)}%) — no derivatives-driven bias`);
    }
  }

  if (oiHistory.length >= 4) {
    const recentOI  = oiHistory.slice(-4);
    const oiChange  = (recentOI[3].oi - recentOI[0].oi) / recentOI[0].oi * 100;
    const priceChange = analysis.candles.length >= 4
      ? (analysis.candles[analysis.candles.length - 1].close - analysis.candles[analysis.candles.length - 4].close) / analysis.candles[analysis.candles.length - 4].close * 100
      : 0;

    if (oiChange > 3 && priceChange > 1) {
      score += 1;
      reasons.push(`OI rising +${oiChange.toFixed(1)}% with price up ${priceChange.toFixed(1)}% — new longs entering, trend extension likely`);
    } else if (oiChange > 3 && priceChange < -1) {
      score -= 1.5;
      reasons.push(`OI rising +${oiChange.toFixed(1)}% with price falling ${priceChange.toFixed(1)}% — fresh short positions building, bearish continuation signal`);
    } else if (oiChange < -3 && priceChange > 1) {
      score += 0.5;
      reasons.push(`OI falling ${oiChange.toFixed(1)}% with price rising — short covering rally, less sustainable but bullish short-term`);
    } else if (oiChange < -3 && priceChange < -1) {
      score += 0.5;
      reasons.push(`OI falling ${oiChange.toFixed(1)}% with price falling — long liquidations, washout may be near completion`);
    }
  }

  if (takerFlow) {
    const { takerBias } = takerFlow;
    if (takerBias > 15) {
      score += 0.5;
      reasons.push(`Taker buy flow dominant (${takerBias.toFixed(1)}% net buy) — aggressive buyers lifting asks`);
    } else if (takerBias < -15) {
      score -= 0.5;
      reasons.push(`Taker sell flow dominant (${Math.abs(takerBias).toFixed(1)}% net sell) — aggressive sellers hitting bids`);
    }
  }

  return { score, reasons };
}

function scoreOrderBook(analysis) {
  const { obAnalysis } = analysis;
  if (!obAnalysis) return { score: 0, reasons: ['Order book data unavailable'] };

  let score = 0, reasons = [];
  const { bidAskRatio, nearImbalance, bidWalls, askWalls, bias } = obAnalysis;

  if (bias === 'bullish') {
    score += 1;
    reasons.push(`Order book skewed bullish (${(bidAskRatio * 100).toFixed(0)}% bid depth) — more buyers stacked below`);
  } else if (bias === 'bearish') {
    score -= 1;
    reasons.push(`Order book skewed bearish (${((1 - bidAskRatio) * 100).toFixed(0)}% ask depth) — more sellers stacked above`);
  }

  if (bidWalls.length > 0) {
    reasons.push(`Large bid wall at $${bidWalls[0].price.toFixed(2)} (${bidWalls[0].size.toFixed(1)} lots) — strong support cluster`);
  }
  if (askWalls.length > 0) {
    reasons.push(`Large ask wall at $${askWalls[0].price.toFixed(2)} (${askWalls[0].size.toFixed(1)} lots) — significant resistance`);
  }

  return { score, reasons };
}

// ═══════════════════════════════════════════════
//  MASTER SIGNAL GENERATOR
// ═══════════════════════════════════════════════
function generateSignal(data, analysis) {
  const scores = {
    structure:   scoreMarketStructure(analysis),
    orderBlocks: scoreOrderBlocks(analysis),
    fvg:         scoreFVGs(analysis),
    premDisc:    scorePremiumDiscount(analysis),
    rsi:         scoreRSI(analysis),
    macd:        scoreMACD(analysis),
    emas:        scoreEMAStack(analysis),
    derivatives: scoreDerivatives(data, analysis),
    orderBook:   scoreOrderBook(analysis),
  };

  const weights = {
    structure: 2, orderBlocks: 2, fvg: 1, premDisc: 1.5,
    rsi: 1.5, macd: 1, emas: 1.5, derivatives: 2, orderBook: 1,
  };
  let totalScore = 0, maxScore = 0;
  for (const [key, s] of Object.entries(scores)) {
    totalScore += s.score * (weights[key] || 1);
    maxScore   += 2 * (weights[key] || 1);
  }
  const normalizedScore = Math.round((totalScore / maxScore) * 100);

  let bias, biasLabel, biasColor;
  if (normalizedScore >= 40)       { bias = 'LONG';       biasLabel = '⬆ LONG';       biasColor = '#00e676'; }
  else if (normalizedScore >= 15)  { bias = 'LEAN_LONG';  biasLabel = '↗ LEAN LONG';  biasColor = '#69f0ae'; }
  else if (normalizedScore <= -40) { bias = 'SHORT';      biasLabel = '⬇ SHORT';      biasColor = '#ff4444'; }
  else if (normalizedScore <= -15) { bias = 'LEAN_SHORT'; biasLabel = '↘ LEAN SHORT'; biasColor = '#ff7070'; }
  else                             { bias = 'NEUTRAL';    biasLabel = '↔ NEUTRAL';    biasColor = '#ffd54f'; }

  const setup = generateSetup(analysis, data, bias, scores);

  return { scores, normalizedScore, bias, biasLabel, biasColor, setup };
}

// ═══════════════════════════════════════════════
//  TRADE SETUP GENERATOR
// ═══════════════════════════════════════════════
function generateSetup(analysis, data, bias, scores) {
  const { price, lastATR, orderBlocks, fvgs, liqLevels, premDisc, srLevels } = analysis;
  if (!price || !lastATR) return null;

  const isLong  = bias === 'LONG' || bias === 'LEAN_LONG';
  const isShort = bias === 'SHORT' || bias === 'LEAN_SHORT';
  if (!isLong && !isShort) return null;

  let entry, sl, tp1, tp2, tp3, slReason, entryReason, tp1Reason, tp2Reason, tp3Reason;

  const freshDemand = orderBlocks.filter(ob => ob.type === 'demand' && ob.state === 'fresh').sort((a, b) => b.low - a.low);
  const freshSupply = orderBlocks.filter(ob => ob.type === 'supply' && ob.state === 'fresh').sort((a, b) => a.low - b.low);

  if (isLong) {
    entry = price;
    entryReason = `Enter long at market ($${price.toFixed(2)}) or on retest of nearest demand zone`;

    if (freshDemand.length > 0) {
      sl = freshDemand[0].low - lastATR * 0.3;
      slReason = `Stop below demand OB at $${freshDemand[0].low.toFixed(2)} — invalidation if price closes below this zone`;
    } else {
      sl = price - lastATR * 1.5;
      slReason = `Stop 1.5×ATR below entry ($${sl.toFixed(2)}) — structural invalidation level`;
    }

    const risk = price - sl;
    tp1 = price + risk * 1.5;
    tp2 = price + risk * 2.5;
    tp3 = price + risk * 4.0;

    const resistanceLevels = srLevels.filter(s => s.type === 'resistance' && s.price > price).sort((a, b) => a.price - b.price);
    if (resistanceLevels.length > 0) tp1 = resistanceLevels[0].price;
    if (resistanceLevels.length > 1) tp2 = resistanceLevels[1].price;
    if (freshSupply.length > 0 && freshSupply[0].low > price) tp2 = freshSupply[0].low;

    const liquidity = liqLevels.shortLiqs.filter(l => l.price > price);
    if (liquidity.length > 0 && liquidity[0].price > tp2) tp3 = liquidity[0].price;

    // Enforce strict ascending order: tp1 < tp2 < tp3
    // Overrides from S/R / OB / liquidity can produce out-of-order TPs.
    // Sort and re-assign so the displayed sequence always makes sense.
    [tp1, tp2, tp3] = [tp1, tp2, tp3].sort((a, b) => a - b);

    tp1Reason = `TP1 at $${tp1.toFixed(2)} (1.5R) — nearest resistance / partial profit`;
    tp2Reason = `TP2 at $${tp2.toFixed(2)} (2.5R) — supply OB / major resistance zone`;
    tp3Reason = `TP3 at $${tp3.toFixed(2)} (4R) — liquidity cluster / extended target`;

  } else {
    entry = price;
    entryReason = `Enter short at market ($${price.toFixed(2)}) or on retest of nearest supply zone`;

    if (freshSupply.length > 0) {
      sl = freshSupply[0].high + lastATR * 0.3;
      slReason = `Stop above supply OB at $${freshSupply[0].high.toFixed(2)} — invalidation if price closes above this zone`;
    } else {
      sl = price + lastATR * 1.5;
      slReason = `Stop 1.5×ATR above entry ($${sl.toFixed(2)}) — structural invalidation level`;
    }

    const risk = sl - price;
    tp1 = price - risk * 1.5;
    tp2 = price - risk * 2.5;
    tp3 = price - risk * 4.0;

    const supportLevels = srLevels.filter(s => s.type === 'support' && s.price < price).sort((a, b) => b.price - a.price);
    if (supportLevels.length > 0) tp1 = supportLevels[0].price;
    if (supportLevels.length > 1) tp2 = supportLevels[1].price;
    if (freshDemand.length > 0 && freshDemand[0].high < price) tp2 = freshDemand[0].high;

    const liquidity = liqLevels.longLiqs.filter(l => l.price < price);
    if (liquidity.length > 0 && liquidity[0].price < tp2) tp3 = liquidity[0].price;

    // Enforce strict descending order for shorts: tp1 > tp2 > tp3
    [tp1, tp2, tp3] = [tp1, tp2, tp3].sort((a, b) => b - a);

    tp1Reason = `TP1 at $${tp1.toFixed(2)} (1.5R) — nearest support / partial profit`;
    tp2Reason = `TP2 at $${tp2.toFixed(2)} (2.5R) — demand OB / major support zone`;
    tp3Reason = `TP3 at $${tp3.toFixed(2)} (4R) — liquidity cluster / extended target`;
  }

  const risk    = Math.abs(price - sl);
  const rr1     = risk > 0 ? Math.abs(tp1 - price) / risk : 0;
  const rr2     = risk > 0 ? Math.abs(tp2 - price) / risk : 0;
  const rr3     = risk > 0 ? Math.abs(tp3 - price) / risk : 0;
  const riskPct = (risk / price * 100).toFixed(2);

  const invalidationPrice  = sl;
  const invalidationReason = isLong
    ? `Setup invalidated if candle closes below $${sl.toFixed(2)} — indicates demand zone failure and bearish structure shift`
    : `Setup invalidated if candle closes above $${sl.toFixed(2)} — indicates supply zone failure and bullish structure shift`;

  const bullScenario = generateNarrative(analysis, data, 'bull');
  const bearScenario = generateNarrative(analysis, data, 'bear');

  return {
    direction: isLong ? 'LONG' : 'SHORT',
    entry, sl, tp1, tp2, tp3,
    rr1: rr1.toFixed(1), rr2: rr2.toFixed(1), rr3: rr3.toFixed(1),
    riskPct,
    entryReason, slReason, tp1Reason, tp2Reason, tp3Reason,
    invalidationPrice, invalidationReason,
    bullScenario, bearScenario,
  };
}

function generateNarrative(analysis, data, direction) {
  const { price, structure, premDisc, lastRSI, lastEMAs, orderBlocks } = analysis;
  const { ticker, fundingHist } = data;

  const fr      = ticker?.fundingRate || 0;
  const zone    = premDisc?.zone || 'equilibrium';
  const trend   = structure?.trend || 'neutral';
  const freshDemand = orderBlocks?.filter(ob => ob.type === 'demand' && ob.state === 'fresh') || [];
  const freshSupply = orderBlocks?.filter(ob => ob.type === 'supply' && ob.state === 'fresh') || [];
  const nearestDemand = freshDemand.sort((a, b) => b.low - a.low)[0];
  const nearestSupply = freshSupply.sort((a, b) => a.low - b.low)[0];

  if (direction === 'bull') {
    const obRef  = nearestDemand ? `Nearest demand OB at $${nearestDemand.low.toFixed(2)}–$${nearestDemand.high.toFixed(2)} is the key support.` : 'No fresh demand OBs nearby.';
    const obTrig = nearestSupply ? `A close above the $${nearestSupply.low.toFixed(2)} supply OB would confirm new bullish momentum.` : 'A clear BOS to the upside would confirm continuation.';
    return [
      `Price is currently trading in the ${zone} zone of its recent range.`,
      `If bullish market structure holds (trend: ${trend}), expect a continuation move toward the premium zone.`,
      obTrig,
      `${obRef}`,
      `Funding at ${fr.toFixed(4)}% ${fr < 0 ? '— shorts paying longs, supportive for bulls' : fr > 0.05 ? '— longs paying, watch for overheating' : '— neutral, no squeeze pressure'}.`,
      `RSI at ${lastRSI?.toFixed(1) || 'N/A'} ${(lastRSI || 50) < 50 ? 'has room to recover to 70 before becoming extended' : 'is elevated — monitor for divergence'}.`,
    ].join(' ');
  } else {
    const obRef  = nearestSupply ? `Nearest supply OB at $${nearestSupply.low.toFixed(2)}–$${nearestSupply.high.toFixed(2)} is the key resistance.` : 'No fresh supply OBs nearby.';
    const obTrig = nearestDemand ? `A close below the $${nearestDemand.high.toFixed(2)} demand OB would confirm bearish breakdown.` : 'A CHoCH to the downside would confirm the bearish case.';
    return [
      `Price is currently in the ${zone} zone — ${zone === 'premium' ? 'historically unfavorable for longs' : 'potential distribution area'}.`,
      `If bearish market structure holds (trend: ${trend}), expect a pullback toward discount / demand zones.`,
      obTrig,
      `${obRef}`,
      `Funding at ${fr.toFixed(4)}% — ${fr > 0.05 ? 'elevated, increasing long liquidation risk' : 'neutral, no immediate squeeze catalyst'}.`,
      `EMA 200 at $${lastEMAs?.ema200?.toFixed(2) || 'N/A'} is the ultimate support — a reclaim would neutralize the bearish case.`,
    ].join(' ');
  }
}

// ═══════════════════════════════════════════════
//  MTF BIAS TABLE GENERATOR
//  NEW: produces the 5-row timeframe bias table
//  that renders in the centre panel below structure grid.
//
//  Returns array of { tf, trend, structure, keyLevel, distPct }
//  so app.js can render it cleanly.
// ═══════════════════════════════════════════════
function generateMTFBias(analysis, rawData) {
  const { structure, htfStructure, ltfStructure, price, pivotHighs, pivotLows, srLevels } = analysis;

  // Helper: get the nearest S/R level for a given trend
  function nearestLevel(trend) {
    if (!srLevels?.length) return null;
    const candidates = trend === 'bull'
      ? srLevels.filter(l => l.type === 'resistance' && l.price > price).sort((a, b) => a.price - b.price)
      : srLevels.filter(l => l.type === 'support'    && l.price < price).sort((a, b) => b.price - a.price);
    return candidates[0] || null;
  }

  // Helper: get last structure event tag for a structure object
  function lastEventTag(st) {
    if (!st?.events?.length) return '—';
    const ev = st.events[st.events.length - 1];
    if (ev.type === 'BOS')   return ev.dir === 'bull' ? 'HH BOS' : 'LL BOS';
    if (ev.type === 'CHoCH') return 'CHoCH';
    return ev.type;
  }

  // Helper: dist % from price to a level
  function dist(lvl) {
    if (!lvl) return null;
    return ((lvl.price - price) / price * 100);
  }

  // LTF (15m) — use ltfStructure if available, else approximate from structure events
  const ltfTrend   = ltfStructure?.trend || analysis.kltfStructure?.trend || '—';
  const ltfEvt     = lastEventTag(ltfStructure || analysis.kltfStructure);
  const ltfLevel   = nearestLevel(ltfTrend);

  // MTF (primary TF) — analysis.structure
  const mtfTrend   = structure?.trend || '—';
  const mtfEvt     = lastEventTag(structure);
  const mtfLevel   = nearestLevel(mtfTrend);

  // HTF (4H)
  const htfTrend4h = htfStructure?.trend || '—';
  const htfEvt4h   = lastEventTag(htfStructure);
  const htfLevel4h = nearestLevel(htfTrend4h);

  // 1D — use swingHigh/Low pivots as proxy for daily level
  const pivH       = pivotHighs?.slice(-1)[0];
  const pivL       = pivotLows?.slice(-1)[0];
  const dailyLevel = pivH && pivL
    ? (Math.abs(pivH.price - price) < Math.abs(pivL.price - price) ? { price: pivH.price } : { price: pivL.price })
    : mtfLevel;
  // For daily trend, use HTF as proxy if no separate daily structure
  const dailyTrend = htfStructure?.trend || '—';

  // 1W — use the furthest pivot
  const weeklyLevel = pivH ? { price: pivH.price } : null;
  const weeklyTrend = htfStructure?.trend || '—';

  const rows = [
    {
      tf:        '15M',
      trend:     ltfTrend,
      structure: ltfEvt,
      keyLevel:  ltfLevel,
      distPct:   dist(ltfLevel),
    },
    {
      tf:        '1H',
      trend:     mtfTrend,
      structure: mtfEvt,
      keyLevel:  mtfLevel,
      distPct:   dist(mtfLevel),
    },
    {
      tf:        '4H',
      trend:     htfTrend4h,
      structure: htfEvt4h,
      keyLevel:  htfLevel4h,
      distPct:   dist(htfLevel4h),
    },
    {
      tf:        '1D',
      trend:     dailyTrend,
      structure: '—',
      keyLevel:  dailyLevel,
      distPct:   dist(dailyLevel),
    },
    {
      tf:        '1W',
      trend:     weeklyTrend,
      structure: '—',
      keyLevel:  weeklyLevel,
      distPct:   dist(weeklyLevel),
      isActive:  true,   // mark current TF
    },
  ];

  return rows;
}

export { generateSignal, generateMTFBias, scoreMarketStructure, scoreOrderBlocks };
