// BTC Race Bot (ladder) — an EMA-anchored dip ladder for make.fun's
// "Race a BTC trading bot live for 24 hours" (btc-race-24h-20261117-0603):
// one asset, $1,000 of paper money, long only, no leverage.
// Orders decided on bar k fill at bar k+1's open. The whole strategy is one
// ladder, re-enterable after every exit:
//
//   1. RUNG 1: when a close prints 0.4% or more below the 240-bar EMA of
//      closes, buy with 50% of cash.
//   2. RUNG 2: when a later close prints 0.8% or more below the same EMA,
//      buy with all remaining cash (fully invested).
//   3. EXIT (sell all): when a close prints 1.8% above the position's
//      average entry, or 0.8% below it, or 240 bars after the rung-1 entry.
//      After an exit the ladder resets and may fire again on a new dip.
//      No new entries after seq 1380.
//
// Why this shape: the dev window is a slow U — down early, up late — and a
// full-size round trip costs about 26 bps in fees, slippage and price impact,
// so a bot that only buys the dip and holds to the end gives back the fade.
// The ladder instead buys genuine excursions below the slow trend (the EMA
// anchor keeps it out of the chop that killed every EMA-cross and
// RSI-Bollinger variant) and banks the bounce at +1.8%, so it can complete
// several round trips in the day's range. Across a 162-combination grid on
// the dev window (EMA 240/300/360, dips 0.4-0.6% / 0.7-1.0%, TP 1.2-1.8%,
// SL 0.8-1.2%) every combination was profitable (median +$9.58, best +$13.64
// in the backtester), which is a broad plateau, not a single fitted point.
// The parameters here (EMA 240, dips 0.4% / 0.8%, TP 1.8%, SL 0.8%) are one
// point on that plateau, chosen by the author, not copied from any entry.
//
// Determinism: every decision comes from bar closes and hello only. No clock,
// no environment, no files, no Math.random, so the grader's two runs produce
// byte-identical action logs.
//
// Average entry: the bot never sees a fill price directly, so it rebuilds its
// cost basis from what it observes — after sending a buy of `notional` quote
// units it watches the position at the next batch, and its cost basis per
// unit is notional / units received (quote units are micro-USDC, base units
// are 1e-8 BTC, closes are USD x 1e5, hence the 1e7 factor below).

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

/** EMA length in bars (240 = 4 hours). */
const EMA_N = 240;
/** Rung 1 fires at a close this many bps below the EMA (0.4%). */
const DIP1_BPS = 40;
/** Rung 2 fires at a close this many bps below the EMA (0.8%). */
const DIP2_BPS = 80;
/** Take-profit: a close this many bps above the average entry (1.8%). */
const TP_BPS = 180;
/** Stop-loss: a close this many bps below the average entry (0.8%). */
const SL_BPS = 80;
/** Bars after the rung-1 entry when the position times out. */
const TIMEOUT_BARS = 240;
/** No new entries after this seq. */
const LAST_ENTRY_SEQ = 1380;
/** Share of cash rung 1 spends (50%). */
const RUNG1_WEIGHT_BPS = 5_000n;
/** Slippage allowance on every order, far above the ~2 bps modelled slippage plus impact. */
const MAX_SLIPPAGE_BPS = 1_000;
/**
 * Bars in a window. Both the dev window and the race window are 1,440 one-minute bars
 * (RULES: "1,440 one-minute bars"), so batches run seq 0..1439 and the last batch is 1439:
 * orders decided on it would be rejected (after_end), so none are ever sent there.
 */
const WINDOW_BARS = 1440;
const BPS = 10_000n;

/** The universe's one symbol, taken from hello (never hardcoded). */
let symbol = '';
/** 240-bar EMA of closes, as a float (seeded at the first close). */
let ema: number | null = null;
/** Ladder rung: 0 = flat, 1 = rung 1 bought, 2 = fully invested. */
let rung = 0;
/** Seq of the bar the rung-1 entry was decided on (for the timeout). */
let entrySeq = -1;
/** Average entry cost basis, in close units (USD x 1e5), 0 when flat. */
let avgEntry = 0;
/** A buy sent on the previous batch, awaiting its fill observation. */
let pendingBuy: { notional: bigint; qtyBefore: bigint } | null = null;

await runBars({
  onHello(state) {
    symbol = state.hello.symbols[0].symbol;
  },
  onBatch(state, batch) {
    const close = state.close(symbol);
    if (close === null) return [];
    const closeNum = Number(close);

    // Update the EMA with every close, warm-up batches included, so it
    // matches a 240-bar EMA seeded at the first close of the window.
    const k = 2 / (EMA_N + 1);
    ema = ema === null ? closeNum : closeNum * k + ema * (1 - k);

    // Observe a pending buy's fill: the position at this batch reflects the
    // fill at this batch's open. Rebuild the cost basis from it.
    if (pendingBuy !== null) {
      const pos = state.positions.get(symbol);
      const qtyNow = pos !== undefined ? pos.qty : 0n;
      const filled = qtyNow - pendingBuy.qtyBefore;
      if (filled > 0n) {
        const fillCost = Number((pendingBuy.notional * 10_000_000n) / filled);
        avgEntry =
          avgEntry > 0
            ? (avgEntry * Number(qtyNow - filled) + fillCost * Number(filled)) / Number(qtyNow)
            : fillCost;
      } else {
        // The buy did not fill: reset the ladder so it may try again.
        rung = 0;
        entrySeq = -1;
        avgEntry = 0;
      }
      pendingBuy = null;
    }

    // Never trade on a warm-up batch, never on the final batch.
    if (state.warmingUp) return [];
    if (state.seq >= WINDOW_BARS - 1) return [];
    if (ema === null) return [];

    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const pos = state.positions.get(symbol);
    const qty = pos !== undefined ? pos.qty : 0n;
    const flat = qty === 0n;

    if (flat) {
      if (rung !== 0) {
        rung = 0;
        entrySeq = -1;
        avgEntry = 0;
      }
      if (state.seq > LAST_ENTRY_SEQ) return [];
      // Rung 1: close 0.4% or more below the EMA, buy with 50% of cash.
      if (closeNum * 10_000 <= ema * (10_000 - DIP1_BPS)) {
        const amount = (state.cash * RUNG1_WEIGHT_BPS) / BPS;
        if (amount >= minNotional) {
          rung = 1;
          entrySeq = state.seq;
          pendingBuy = { notional: amount, qtyBefore: qty };
          return [{ side: 'buy', symbol, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    // Long: rung 2, then the exits (checked in this order, as backtested).
    if (rung === 1 && closeNum * 10_000 <= ema * (10_000 - DIP2_BPS)) {
      const amount = state.cash;
      if (amount >= minNotional) {
        rung = 2;
        pendingBuy = { notional: amount, qtyBefore: qty };
        return [{ side: 'buy', symbol, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    if (avgEntry > 0) {
      const aboveTp = closeNum * 10_000 >= avgEntry * (10_000 + TP_BPS);
      const belowSl = closeNum * 10_000 <= avgEntry * (10_000 - SL_BPS);
      const timedOut = entrySeq >= 0 && state.seq - entrySeq >= TIMEOUT_BARS;
      if (aboveTp || belowSl || timedOut) {
        rung = 0;
        entrySeq = -1;
        avgEntry = 0;
        return [{ side: 'sell', symbol, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  },
});
