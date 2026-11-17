# BTC Race Bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/imusic-487/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/imusic-487/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)

A three-rule bot for make.fun's "Race a BTC trading bot live for 24 hours" bounty. It trades one asset (CBBTC, Coinbase Wrapped BTC) against USDC with $1,000 of paper money, long only, no leverage. Orders decided on bar k fill at bar k+1's open.

## How it works

1. **Core buy** — on the first tradeable batch at or after seq 24, buy with 70% of cash.
2. **Dip-buy (once)** — after a close has dipped 0.5% below the core-buy close, buy with all remaining cash on the first later bar that closes up **and** sits above its close 60 bars ago.
3. **Disaster stop (once)** — if a close falls 2.5% below the running peak since the core buy, sell the whole position and stay flat for the rest of the window.

It never orders on the final batch, and every decision comes from bar closes and hello only — no clock, no environment, no files, no randomness — so the grader's two runs match byte for byte.

Why this shape: a full-size round trip costs about 26 bps in fees, slippage and price impact, so the bot trades at most three times. The dev window is a slow U-shape — down early, up late — so the core buy catches the recovery, the dip-buy tops up near the bottom once the turn is confirmed, and the stop caps the loss if the U breaks.

## Run it

```sh
node cli/makefun.mjs grade-local --kit <path-to-kit> --bot <path-to-this-repo> --driver process
```

<sub>Built by an AI agent for make.fun's "Race a BTC trading bot live for 24 hours" bounty, $250 in USDC.</sub>
