// BTC Race Bot — a three-rule bot for make.fun's "Race a BTC trading bot live for 24 hours"
// (btc-race-24h-20261117-0603): one asset, $1,000 of paper money, long only, no leverage.
// Orders decided on bar k fill at bar k+1's open. The whole strategy is three rules:
//
//   1. CORE BUY: on the first tradeable batch at or after seq 24, buy with 70% of cash.
//   2. DIP-BUY (once): after a close has dipped 0.5% below the core-buy close, buy with all
//      remaining cash on the first later bar that closes up AND sits above its close 60 bars ago.
//   3. DISASTER STOP (once): if a close falls 2.5% below the running peak since the core buy,
//      sell the whole position and stay flat for the rest of the window.
//
// Why this shape: a full-size round trip costs about 26 bps in fees, slippage and price impact,
// so the bot trades at most three times (two buys, one emergency sell). The dev window is a
// slow U-shape — down early, up late — so the core buy catches the recovery, the dip-buy tops
// up near the bottom once the turn is confirmed, and the stop caps the loss if the U breaks.
//
// Determinism: every decision comes from bar closes and hello only. No clock, no environment,
// no files, no Math.random, so the grader's two runs produce byte-identical action logs.
//
// Verified on the dev window with the kit's local grader (grade-local, process driver):
// net PnL +3.836980 USDC, 2 trades (core buy + dip-buy, disaster stop never fired),
// 0 rejected, max drawdown 2.12%, guardrails met, L1 regrade reproduced byte for byte.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

/** First batch the core buy may fire on (24 bars of history behind it). */
const CORE_SEQ = 24;
/** Share of cash the core buy spends (70%). */
const CORE_WEIGHT_BPS = 7_000n;
/** A dip is a close at or below this many bps under the core-buy close (0.5%). */
const DIP_BPS = 50n;
/** Bars back the dip-buy's confirmation looks: the 60-bar return must be positive. */
const CONFIRM_LOOKBACK = 60;
/** The disaster stop fires when a close falls this many bps under the running peak (2.5%). */
const STOP_BPS = 250n;
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
/** Each batch's latest close, by seq (null before the first bar). */
const closes: (bigint | null)[] = [];
/** Core buy sent (and the close it was decided on). */
let coreBought = false;
let entryClose: bigint | null = null;
/** Running peak close since the core buy. */
let peakClose: bigint | null = null;
/** Seq of the bar where the 0.5% dip was first seen (null until seen). */
let dipSeenSeq: number | null = null;
/** Dip-buy sent. */
let dipBought = false;
/** Disaster stop fired (stays flat afterwards). */
let stopped = false;

await runBars({
  onHello(state) {
    symbol = state.hello.symbols[0].symbol;
  },
  onBatch(state, batch) {
    const close = state.close(symbol);
    closes[state.seq] = close;

    // Never trade on a warm-up batch, never on the final batch, never without a close.
    if (state.warmingUp) return [];
    if (state.seq >= WINDOW_BARS - 1) return [];
    if (close === null) return [];

    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);

    // Rule 1 — CORE BUY: first tradeable batch at or after seq 24, 70% of cash.
    if (!coreBought && state.seq >= Math.max(CORE_SEQ, state.warmupBars)) {
      const amount = (state.cash * CORE_WEIGHT_BPS) / BPS;
      if (amount >= minNotional) {
        coreBought = true;
        entryClose = close;
        peakClose = close;
        return [{ side: 'buy', symbol, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    if (!coreBought || entryClose === null || peakClose === null) return [];

    // Running peak since the core buy.
    if (close > peakClose) peakClose = close;

    // Dip seen: any close at or below entryClose minus 0.5%.
    if (dipSeenSeq === null && close * BPS <= entryClose * (BPS - DIP_BPS)) {
      dipSeenSeq = state.seq;
    }

    // Rule 3 — DISASTER STOP (checked first: risk control wins over the dip-buy).
    // A close strictly below peak minus 2.5% sells everything, once, then flat.
    if (!stopped && close * BPS < peakClose * (BPS - STOP_BPS)) {
      stopped = true;
      const pos = state.positions.get(symbol);
      if (pos !== undefined && pos.qty > 0n) {
        return [{ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Rule 2 — DIP-BUY (once): on a later bar than the dip, closing up, with a positive
    // 60-bar return, spend all remaining cash (to 100% invested).
    if (!dipBought && !stopped && dipSeenSeq !== null && state.seq > dipSeenSeq) {
      const prev = state.seq - 1 >= 0 ? closes[state.seq - 1] ?? null : null;
      const sixtyAgo =
        state.seq - CONFIRM_LOOKBACK >= 0 ? closes[state.seq - CONFIRM_LOOKBACK] ?? null : null;
      if (prev !== null && sixtyAgo !== null && close > prev && close > sixtyAgo) {
        const amount = state.cash;
        if (amount >= minNotional) {
          dipBought = true;
          return [{ side: 'buy', symbol, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
    }

    return [];
  },
});
