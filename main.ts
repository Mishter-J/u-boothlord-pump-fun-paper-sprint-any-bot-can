// Floor-rider: an early-entry, asymmetric-payoff bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2). It buys coins in their first minute of life, within a few percent
// of their create price — where the curve's price floor bounds the downside — and sells into
// strength on a take-profit ladder with a trailing stop for the runners. See strategy.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
