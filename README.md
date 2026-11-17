# BTC Race Bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/imusic-487/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/imusic-487/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)

An EMA-anchored dip ladder for make.fun's "Race a BTC trading bot live for 24 hours" bounty. It trades one asset (CBBTC, Coinbase Wrapped BTC) against USDC with $1,000 of paper money, long only, no leverage. Orders decided on bar k fill at bar k+1's open.

## How it works

1. **Rung 1** — when a close prints 0.4% or more below the 240-bar EMA of closes, buy with 50% of cash.
2. **Rung 2** — when a later close prints 0.8% or more below the same EMA, buy with all remaining cash.
3. **Exit** — sell everything when a close prints 1.8% above the position's average entry, or 0.8% below it, or 240 bars after the rung-1 entry. After an exit the ladder resets and may fire again on a new dip. No new entries after seq 1380.

The EMA anchor is the point: it only buys genuine excursions below the slow trend, so it stays out of the chop that kills every EMA-cross and RSI-Bollinger variant, and it banks each bounce at +1.8% instead of holding through the end-of-day fade. The average entry is rebuilt from observed fills (cost basis = notional / units received).

## Grade (local, `grade-local --driver process`)

```
net PnL   13.528055 USDC
trading   10 trades, win rate 0.75, max drawdown 0.82%, exposure 0.34
fees      2.416379 USDC; at 2x fees net PnL 11.103136 USDC
guardrails met, L1 regrade reproduced byte for byte
```

For comparison, buy-and-hold scores +$1.07 and momentum +$2.45 on the same dev window, and the bot's own earlier version (70% core + one dip-buy) scored +$3.84. The ladder was picked from a 162-combination grid (EMA 240/300/360, dips 0.4–0.6% / 0.7–1.0%, TP 1.2–1.8%, SL 0.8–1.2%) in which every combination was profitable (median +$9.58) — a broad plateau, not a single fitted point.

## Run it

```
node main.ts   # via the kit: grade-local --kit <kit> --bot . --driver process
```

Node 22, standard library only (plus the vendored `vendor/makefun-bars.ts` shim, byte-identical to the kit's SDK). No network, no clock, no randomness: two runs produce byte-identical action logs.
