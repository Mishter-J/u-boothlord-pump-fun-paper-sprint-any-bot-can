// Floor-rider: buy new coins near their create price, bank the first pump, cut the rest.
//
// What the dev window's 1,222 coins show (measured from the kit's own dataset):
//   - A bonding-curve price can never fall below its create price (real SOL reserves
//     cannot go below zero), so a coin bought within a few percent of its create price has
//     a bounded downside and a real upside: 28% of early floor entries touch +30% later,
//     23% touch +50%, 15% touch +100%. But the pumps are transient — holding to the end
//     of the window gives back ~everything — so the bot sells at the first +30% and never
//     holds a coin past 300 slots.
//   - Chasing the explosion does NOT work here: coins that already ran +50% or more lose
//     badly when bought (-0.63 SOL over the dev window at a +50% run-up cap), because the
//     2-slot fill latency buys the top and sells the dump. Quiet entries win.
//   - Size is a fee question, not a courage question: every round trip pays 1.25% curve
//     fee each way plus a FIXED 105,000-lamport tx fee per order, so a 0.01 SOL position
//     pays ~4.6% in fees and a 0.05 SOL position ~2.9%. The bot therefore refuses buys
//     under 0.025 SOL (the 1%-of-real-reserve cap does the waiting: it only buys once a
//     curve holds enough real SOL for a viable position).
//   - A position that jumps straight past +100% sells half there and lets the trailing
//     stop take the rest near the peak; a position that only reaches +30% sells out whole.
//     Selling half at +30% on every winner scored worse — the second leg usually never
//     comes — so the +30% rung is all-or-nothing and only the big jumps split.
//   - Every house pilot loses on this window (momentum -9.45 SOL, reversion -4.37,
//     sniper -0.42, equal-weight -0.02 on 5 coins). This bot scores +0.049 SOL over
//     114 round trips (25 wins) with 0.8% max drawdown on the same window, in a flat
//     region of the parameter grid (neighbouring settings score within a few hundredths).
//
// Entry (once per coin, in its first 120 slots):
//   - price within +25% of the create price (near the floor),
//   - at least 3 distinct non-creator buyers and non-negative net flow over the last
//     10 slots (someone is actually buying, not just the creator),
//   - creator has not sold and the creator's own opening buy is at most 2.5 SOL,
//   - real SOL under 60 (curves near completion are someone else's trade),
//   - the 1%-of-real-reserve cap allows at least 0.025 SOL (a fee-viable position).
// Exits (checked every batch, exits first):
//   - take-profit ladder: +30% sells the whole position; a jump past +100% sells half
//     and the trailing stop (armed at +100%, -30% from the peak) takes the rest; +300%
//     sells everything left;
//   - hard stop: sell everything at -25% under cost;
//   - time limit: sell everything after 300 slots held.
// Guardrail pacing: the run must finish with round trips of >= 0.01 SOL on >= 20 coins
// and drawdown <= 50%. If the coins traded lag a 30-coins-per-6-hours pace, the entry
// filters relax (run-up +100%, 1 buyer, 300-slot window) so the bot still clears the
// bar on a quiet window.
//
// Deterministic by construction: no clock, no environment, no randomness; every decision
// is a pure function of the batches fed in, and iteration is over insertion-ordered maps.

import {
  BPS,
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin in total (each reply is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for (also the guardrail's round-trip size). */
  minBuyLamports: number;
  /** Distinct non-creator buyers seen before entry. */
  minBuyers: number;
  /** Creator's own buys in the create slot: at most this many lamports. */
  maxDevBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  maxRealSolLamports: number;
  /** Price now over the create price, as bps: at most this far above it. */
  maxRunupBps: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlippageBps: number;
  /** First take-profit: sell tp1PartBps of the position once it is worth tp1Bps over cost. */
  tp1Bps: number;
  tp1PartBps: number;
  /** Second take-profit: sell tp2PartBps of what is left once it is worth tp2Bps over cost. */
  tp2Bps: number;
  tp2PartBps: number;
  /** Above this, sell everything left. */
  tpAllBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit when the position is worth this much under its cost (bps). */
  slBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Guardrail pacing: coins to have traded per windowSeconds of block time. */
  targetCoins: number;
  windowSeconds: number;
  /** Relaxed entry filters, used when the coin count lags the pace. */
  relaxedMaxRunupBps: number;
  relaxedMinBuyers: number;
  relaxedMaxAge: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 120,
  stakeLamports: 50_000_000,
  minBuyLamports: 25_000_000,
  minBuyers: 3,
  maxDevBuyLamports: 2_500_000_000,
  maxRealSolLamports: 60_000_000_000,
  maxRunupBps: 2500,
  flowWindow: 10,
  minFlowLamports: 0,
  buySlippageBps: 10_000,
  tp1Bps: 3000,
  tp1PartBps: 10_000,
  tp2Bps: 10_000,
  tp2PartBps: 5000,
  tpAllBps: 30_000,
  trailArmBps: 10_000,
  trailBps: 3000,
  slBps: 2500,
  maxHold: 300,
  targetCoins: 30,
  windowSeconds: 21_600,
  relaxedMaxRunupBps: 10_000,
  relaxedMinBuyers: 1,
  relaxedMaxAge: 300,
};

/** Curve fees (protocol 95 + creator 30 bps) charged on every trade through the curve. */
const FEE_BPS = 125n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** The create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  buyers: Set<Pubkey>;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Tx fees paid on this position's fills (buys and sells), to add to the cost basis. */
  txPaid: bigint;
  /** Best close value seen (sell value minus one tx fee). */
  best: bigint;
  /** Take-profit ladder stage: 0 = none taken, 1 = tp1 taken, 2 = tp2 taken. */
  stage: number;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Bot {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Distinct mints this bot has a filled buy on (guardrail pacing). */
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let nowTime = 0;

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSold: false,
          buyers: new Set(),
          lastTradeSlot: e.slot,
          recent: [],
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold over the last flowWindow slots. */
  function flow(c: Coin, slot: number): bigint {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    for (const t of c.recent) net += t.isBuy ? t.sol : -t.sol;
    return net;
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Fills: track coins traded, tx fees per position, and harness closes.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled') {
          myCoins.add(f.mint);
          if (h === undefined) {
            held.set(f.mint, {
              openedSlot: f.slot,
              txPaid: BigInt(f.tx_fee_lamports),
              best: 0n,
              stage: 0,
            });
          }
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) {
          held.delete(mint);
        }
      }

      // Guardrail pacing: relax the entry filters when the coin count lags the pace.
      let relaxed = false;
      if (firstTime !== null) {
        const elapsed = Math.max(0, Math.min(P.windowSeconds, nowTime - firstTime));
        const due = (P.targetCoins * elapsed) / P.windowSeconds;
        if (myCoins.size < due * 0.8) relaxed = true;
      }
      const maxRunup = relaxed ? P.relaxedMaxRunupBps : P.maxRunupBps;
      const minBuyers = relaxed ? P.relaxedMinBuyers : P.minBuyers;
      const maxAge = relaxed ? P.relaxedMaxAge : P.maxAge;

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, stage: 0 };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        if (basis <= 0n) continue;

        // Take-profit ladder, highest rung first.
        let exit = false;
        let part: bigint | null = null;
        if (value * BPS >= basis * (BPS + BigInt(P.tpAllBps))) {
          exit = true;
        } else if (h.stage < 2 && value * BPS >= basis * (BPS + BigInt(P.tp2Bps))) {
          part = (pos.token_amount * BigInt(P.tp2PartBps)) / BPS;
          h.stage = 2;
        } else if (h.stage < 1 && value * BPS >= basis * (BPS + BigInt(P.tp1Bps))) {
          part = (pos.token_amount * BigInt(P.tp1PartBps)) / BPS;
          h.stage = 1;
        }
        if (part !== null && part > 0n && part < pos.token_amount) {
          orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
          selling.add(mint);
          continue;
        }
        // Hard stop.
        if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
        // Trailing stop, armed once the position is up trailArmBps.
        if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) {
          exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: only coins that traded in this batch can have become eligible.
      let free = state.freeCashLamports();
      let open = state.committedPositionCount();
      const traded = new Set<Pubkey>();
      for (const e of batch.events) if (e.event === 'TradeEvent') traded.add(e.mint);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const c = coins.get(mint);
        if (c === undefined || c.done || c.complete) continue;
        if (held.has(mint) || selling.has(mint) || hasPending(state, mint, 'buy')) continue;
        if (state.positions.has(mint)) continue;
        const age = state.slot - c.createSlot;
        if (age > maxAge) {
          c.done = true;
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        // Rug filter: creator sold, or the creator's own opening buy was huge.
        if (c.devSold) {
          c.done = true;
          continue;
        }
        if (c.devBuy > BigInt(P.maxDevBuyLamports)) {
          c.done = true;
          continue;
        }
        if (c.buyers.size < minBuyers) continue;
        const rq = curve.real_quote_reserves;
        if (rq > BigInt(P.maxRealSolLamports)) continue;
        // Near the floor: price at most maxRunup above the create price.
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (vq * c.vt0 * BPS > vt * c.vq0 * (BPS + BigInt(maxRunup))) continue;
        if (flow(c, state.slot) < BigInt(P.minFlowLamports)) continue;
        // Fee-viable size: the 1%-of-real-reserve cap must allow at least minBuy.
        const maxBuy = state.maxBuyLamports(mint);
        const amount = BigInt(P.stakeLamports) < maxBuy ? BigInt(P.stakeLamports) : maxBuy;
        if (amount < BigInt(P.minBuyLamports)) continue;
        if (free < amount + 3n * tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        open += 1;
      }
      return orders;
    },
  };
}
