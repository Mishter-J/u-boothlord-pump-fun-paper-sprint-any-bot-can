# u-boothlord-pump-fun-paper-sprint-any-bot-can

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Mishter-J/u-boothlord-pump-fun-paper-sprint-any-bot-can/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Mishter-J/u-boothlord-pump-fun-paper-sprint-any-bot-can/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Floor-rider: a pump.fun paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty, $2 in USDC. It buys new coins near their create price, banks the first +30% pump, and cuts losers at -25% — paper trading only, no real funds.

## Run it

```sh
node main.ts
```

## How it works

A bonding-curve price can never fall below its create price, so a coin bought near its create price has a bounded downside and a real upside — but the pumps are transient, so the bot sells at the first +30% and never holds a coin past 300 slots. It only buys once a curve holds enough real SOL for a fee-viable position (at least 0.025 SOL through the 1%-of-reserve cap), requires at least 3 distinct buyers with non-negative recent flow, and skips launches where the creator sold or bought big. Chasing coins that already ran +50% or more loses badly here (the 2-slot fill latency buys the top), so the bot never chases. On the kit's dev window it scores +0.049 SOL over 114 round trips with 0.8% max drawdown; every house pilot loses on the same window.

## Files

- `main.ts` — the entry program (Node 22, standard library only)
- `strategy.ts` — the floor-rider strategy
- `vendor/makefun-bot.ts` — the kit's bot shim, vendored byte for byte
- `LICENSE` — MIT
- `README.md` — this file

---

<sub>Entered on [make.fun](https://make.fun/?ref=b22w3pzm&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
