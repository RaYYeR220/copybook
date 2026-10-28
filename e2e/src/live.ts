// Live end-to-end run of Copybook on Hideki (chain 50383) against dreamDEX perps.
// COPYBOOK_ENV=<env file> tsx src/live.ts [scenario ...]   (no names: all, in order)
// Every transaction and the hub's same-block reaction to it go to out/proof.json.
import { erc20Abi, formatEther, getAddress, parseEther, type Address, type Hex, type TransactionReceipt } from "viem";
import { account, markets, pub, MARGIN_BANK, OPERATOR_REGISTRY, PLACE_ORDER_FOR, USDSO } from "./env.ts";
import {
  Abort,
  HUB,
  THEMES,
  check,
  decodeHub,
  equity,
  errMsg,
  fmtEvent,
  handlerTxs,
  hubAbi,
  market,
  note,
  poolAbi,
  precompileEvents,
  proof,
  reaction,
  record,
  registryAbi,
  saveProof,
  scenario,
  send,
  sendValue,
  size,
  sleep,
  subscriptionInfo,
  themesAbi,
  type HubEvent,
  type SameBlock,
  type Scenario,
} from "./lib.ts";

const LEADER = account("LEADER").address;
const FOLLOWER = account("FOLLOWER").address;
const FOLLOWER2 = account("FOLLOWER2").address;
const OWNER = account("HUB_OWNER").address;

const TRADER = 0;
const THEME = 1;
const BAND_REFUSED = 7; // Reason.BandUnfilled
const EXIT_MARK_GAS = 4_000_000n;

const reader = markets();
const leaderMk = markets("LEADER");

type Pools = { BTC: Address; ETH: Address; all: { symbol: string; pool: Address }[] };
let pools: Pools;

const policy = (p: Partial<Record<"scaleBps" | "allocation" | "maxNotional" | "maxTotalNotional" | "bandBps" | "equityFloor", bigint | number>>) => ({
  scaleBps: Number(p.scaleBps ?? 0),
  allocation: BigInt(p.allocation ?? 0n),
  maxNotional: BigInt(p.maxNotional ?? parseEther("100")),
  maxTotalNotional: BigInt(p.maxTotalNotional ?? 0n),
  bandBps: Number(p.bandBps ?? 50),
  equityFloor: BigInt(p.equityFloor ?? 0n),
});
const TRADER_POLICY = policy({ scaleBps: 10_000, maxNotional: parseEther("100"), bandBps: 50 });

const hubRead = <T>(functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address: HUB, abi: hubAbi, functionName, args } as never) as Promise<T>;

async function traderSourceId() {
  return hubRead<Hex>("sourceIdOf", [TRADER, BigInt(LEADER)]);
}

async function gasParams() {
  const g = await hubRead<readonly bigint[]>("gasParams");
  return { floor: g[0], perFollowerCap: g[1], themePerFollowerCap: g[2], tailBase: g[3], perDefer: g[4], chargeOverhead: g[5] };
}

// ---------------------------------------------------------------- leader trades and the hub's reaction

async function leaderTrade(s: Scenario, label: string, pool: Address, isBid: boolean, qty: bigint): Promise<TransactionReceipt> {
  const m = await market(pool);
  const raw = isBid ? (m.mark * 10_100n) / 10_000n : (m.mark * 9_900n) / 10_000n;
  const price = isBid ? ((raw + m.tick - 1n) / m.tick) * m.tick : (raw / m.tick) * m.tick;
  const r = (await leaderMk.trader.placePerpOrder({ pool, isBid, price, quantity: qty, orderType: 2, gas: 20_000_000n })) as {
    hash: Hex;
    receipt: TransactionReceipt;
  };
  const rc = r.receipt ?? (await pub.waitForTransactionReceipt({ hash: r.hash }));
  record(s, label, rc);
  if (rc.status !== "success") throw new Error(`${label} reverted`);
  return rc;
}

/** Member gas the handler measured, from TankCharged: amount = (spent + chargeOverhead) * rate. */
async function memberGas(evs: HubEvent[], block: bigint) {
  const charged = evs.find((e) => e.eventName === "TankCharged");
  if (!charged) return undefined;
  const blk = await pub.getBlock({ blockNumber: block });
  const fee = blk.baseFeePerGas ?? 6_000_000_000n;
  const rate = fee > 6_000_000_000n ? fee : 6_000_000_000n;
  const { chargeOverhead } = await gasParams();
  return Number((charged.args.amount as bigint) / rate - chargeOverhead);
}

/** Waits for the hub's handler transaction for `follower` after `trigger`, checks it ran in the same block. */
async function copied(
  s: Scenario,
  label: string,
  trigger: TransactionReceipt,
  follower: Address,
  want: (evs: HubEvent[]) => boolean,
) {
  const entry: SameBlock = {
    scenario: s.name,
    label,
    trigger: trigger.transactionHash,
    triggerBlock: Number(trigger.blockNumber),
    triggerIndex: trigger.transactionIndex,
  };
  const rx = await reaction(trigger, follower, want);
  if (!rx) {
    const runs = await handlerTxs(trigger.blockNumber, 8);
    note(s, `${label} handler runs found by block scan`, runs);
    proof.sameBlock.push(entry);
    saveProof();
    check(s, false, `${label}: hub reacted for ${follower}`);
    if (runs.some((r) => r.status !== "success")) {
      throw new Abort(`handler transactions reverted after ${label}: check R34 (tx.origin == hub)`);
    }
    return undefined;
  }
  record(s, `${label} (handler)`, rx.receipt);
  entry.handler = rx.tx.hash;
  entry.handlerBlock = Number(rx.receipt.blockNumber);
  entry.handlerIndex = rx.receipt.transactionIndex;
  entry.delta = entry.handlerBlock - entry.triggerBlock;
  entry.handlerFrom = rx.tx.from;
  entry.handlerGas = Number(rx.receipt.gasUsed);
  entry.memberGas = await memberGas(rx.events, rx.receipt.blockNumber);
  entry.logs = rx.events.map(fmtEvent);
  proof.sameBlock.push(entry);
  saveProof();
  for (const l of entry.logs) console.log(`    ${l}`);
  check(s, entry.delta === 0, `${label}: handler in the trigger's block (delta ${entry.delta}, trigger idx ${entry.triggerIndex}, handler idx ${entry.handlerIndex})`);
  check(s, getAddress(rx.tx.from) === HUB, `${label}: handler tx.origin is the hub (R34), to ${rx.tx.to}`);
  return rx;
}

const isCopy = (pool: Address, to: bigint) => (evs: HubEvent[]) =>
  evs.some((e) => e.eventName === "Copied" && getAddress(e.args.pool as Address) === getAddress(pool) && e.args.toSize === to);

// ---------------------------------------------------------------- scenarios

async function setup(s: Scenario) {
  const perps = (await reader.client.listPerpMarkets()) as { baseSymbol: string; poolAddress: Address; marginBank: Address }[];
  const bySym = (x: string) => getAddress(perps.find((p) => p.baseSymbol === x)!.poolAddress);
  pools = { BTC: bySym("BTC"), ETH: bySym("ETH"), all: perps.map((p) => ({ symbol: p.baseSymbol, pool: getAddress(p.poolAddress) })) };
  note(s, "pools", { BTC: pools.BTC, ETH: pools.ETH, markets: perps.length });

  // margin top-ups from the hub owner, skipped while a wallet still holds half of one (fees move equity)
  const roles = { LEADER, FOLLOWER, FOLLOWER2 } as const;
  const want: [keyof typeof roles, bigint][] = [
    ["LEADER", parseEther("20")],
    ["FOLLOWER", parseEther("25")],
    ["FOLLOWER2", parseEther("40")],
  ];
  for (const [role, amount] of want) {
    const who = roles[role];
    const eq = await equity(who);
    const stt = await pub.getBalance({ address: who });
    if (stt < parseEther("3")) await sendValue(s, "HUB_OWNER", `STT top-up ${role}`, who, parseEther("3") - stt);
    if (eq >= amount / 2n) {
      note(s, `${role} margin already funded`, formatEther(eq));
      continue;
    }
    await send(s, "HUB_OWNER", `USDso ${formatEther(amount)} to ${role}`, {
      address: USDSO,
      abi: erc20Abi,
      functionName: "transfer",
      args: [who, amount],
    });
    const r = (await markets(role).trader.depositMargin({ marginBank: MARGIN_BANK, amount, gas: 10_000_000n })) as {
      hash: Hex;
      receipt: TransactionReceipt;
    };
    record(s, `${role} depositMargin ${formatEther(amount)}`, r.receipt ?? (await pub.waitForTransactionReceipt({ hash: r.hash })));
  }
  const bal: Record<string, unknown> = {};
  for (const [k, a] of Object.entries({ OWNER, LEADER, FOLLOWER, FOLLOWER2, HUB })) {
    bal[k] = { stt: formatEther(await pub.getBalance({ address: a })), margin: formatEther(await equity(a)) };
  }
  note(s, "balances", bal);
  check(s, (await pub.getBalance({ address: OWNER })) >= parseEther("45"), "hub owner keeps >= 45 STT");
}

async function approvals(s: Scenario) {
  await send(s, "FOLLOWER", "follower: approve hub on BTC (placeOrderFor)", {
    address: OPERATOR_REGISTRY,
    abi: registryAbi,
    functionName: "setOperatorApprovalForPool",
    args: [pools.BTC, HUB, [PLACE_ORDER_FOR], true],
  });
  const viaPool = await pub.readContract({ address: pools.BTC, abi: poolAbi, functionName: "isOperatorAuthorized", args: [FOLLOWER, HUB, PLACE_ORDER_FOR] });
  check(s, viaPool, "BTC pool authorizes the hub for the follower");

  // the theme follower only grants globally; the theme follow shows whether perps honour it
  await send(s, "FOLLOWER2", "follower2: approve hub globally (placeOrderFor)", {
    address: OPERATOR_REGISTRY,
    abi: registryAbi,
    functionName: "setOperatorApprovalGlobal",
    args: [HUB, [PLACE_ORDER_FOR], true],
  });
  const globalFlag = await pub.readContract({ address: OPERATOR_REGISTRY, abi: registryAbi, functionName: "isGloballyApproved", args: [FOLLOWER2, HUB, PLACE_ORDER_FOR] });
  const btcView = await pub.readContract({ address: pools.BTC, abi: poolAbi, functionName: "isOperatorAuthorized", args: [FOLLOWER2, HUB, PLACE_ORDER_FOR] });
  const ethView = await pub.readContract({ address: pools.ETH, abi: poolAbi, functionName: "isOperatorAuthorized", args: [FOLLOWER2, HUB, PLACE_ORDER_FOR] });
  note(s, "global grant: registry flag / BTC pool view / ETH pool view", { globalFlag, btcView, ethView });
  check(s, globalFlag, "registry records the global grant");
}

async function follow(s: Scenario) {
  const sid = await traderSourceId();
  const r = await send(s, "FOLLOWER", "follower: follow leader (scale 1x, max 100, band 50, tank 1 STT)", {
    address: HUB,
    abi: hubAbi,
    functionName: "follow",
    args: [TRADER, BigInt(LEADER), TRADER_POLICY, []],
    value: parseEther("1"),
  });
  const evs = decodeHub(r.logs);
  const opened = evs.find((e) => e.eventName === "GroupOpened");
  check(s, !!evs.find((e) => e.eventName === "Followed"), "Followed emitted");
  check(s, !!opened, "GroupOpened emitted (relay + subscription)");
  const subId = opened?.args.subscriptionId as bigint;
  note(s, "sourceId", sid);
  note(s, "group 0", { relay: opened?.args.relay, subscriptionId: subId?.toString() });
  note(s, "precompile events", precompileEvents(r));
  const info = await subscriptionInfo(subId);
  note(s, "getSubscriptionInfo(live id)", info);
  check(s, info.ok && getAddress(info.owner) === HUB, "precompile reports the hub as the subscription owner");
}

async function openClose(s: Scenario, which: "open" | "close") {
  const isBid = which === "open";
  const before = await size(FOLLOWER, pools.BTC);
  const target = isBid ? 50_000n : 0n;
  note(s, "follower BTC before", before);
  const t = await leaderTrade(s, `leader ${isBid ? "buys" : "sells"} 0.0005 BTC (IOC)`, pools.BTC, isBid, 50_000n);
  await copied(s, `${which} 0.0005 BTC`, t, FOLLOWER, isCopy(pools.BTC, target));
  const after = await size(FOLLOWER, pools.BTC);
  check(s, after === target, `follower BTC = ${target} (is ${after})`);
}

async function moreTrades(s: Scenario) {
  const steps: [string, boolean, bigint, bigint][] = [
    ["leader buys 0.0005 BTC", true, 50_000n, 50_000n],
    ["leader adds 0.0003 BTC", true, 30_000n, 80_000n],
    ["leader sells 0.0008 BTC", false, 80_000n, 0n],
  ];
  for (const [label, isBid, qty, target] of steps) {
    const t = await leaderTrade(s, label, pools.BTC, isBid, qty);
    await copied(s, label, t, FOLLOWER, isCopy(pools.BTC, target));
    check(s, (await size(FOLLOWER, pools.BTC)) === target, `follower BTC = ${target}`);
  }
}

/** The thinnest market our accounts can trade where nothing rests within 5 bps of mark on the ask side. */
async function thinMarket(s: Scenario) {
  const blk = await pub.getBlock();
  const expiry = (blk.timestamp + 60n) * 1_000_000_000n;
  const rows: Record<string, unknown>[] = [];
  let best: { symbol: string; pool: Address; minQty: number; depth50: number; gapBps: number } | undefined;
  for (const { symbol, pool } of pools.all) {
    if (pool === pools.BTC || pool === pools.ETH) continue;
    try {
      const m = await market(pool);
      const asks = await pub.readContract({ address: pool, abi: poolAbi, functionName: "getBookLevels", args: [false, 10n] });
      if (!asks.length) continue;
      const minNotional = Number((m.minQty * m.mark) / m.oneBase) / 1e18;
      const gapBps = Number(((asks[0].price - m.mark) * 1_000_000n) / m.mark) / 100;
      const depth50 = asks
        .filter((l) => l.price * 10_000n <= m.mark * 10_050n)
        .reduce((a, l) => a + Number((l.quantity * l.price) / m.oneBase) / 1e18, 0);
      rows.push({ symbol, gapBps, depth50: Math.round(depth50), minNotional: Math.round(minNotional * 100) / 100 });
      if (gapBps < 15 || minNotional > 15) continue;
      if (best && depth50 >= best.depth50) continue;
      const price = (((m.mark * 10_100n) / 10_000n + m.tick - 1n) / m.tick) * m.tick;
      try {
        await pub.simulateContract({
          account: LEADER,
          address: pool,
          abi: poolAbi,
          functionName: "placeOrder",
          args: [true, 0n, price, m.minQty, expiry, 2, 0, "0x0000000000000000000000000000000000000000", 0n],
          gas: 20_000_000n,
        });
      } catch (e) {
        rows.push({ symbol, tradable: false, why: errMsg(e).slice(0, 120) });
        continue;
      }
      best = { symbol, pool, minQty: Number(m.minQty), depth50, gapBps };
    } catch (e) {
      rows.push({ symbol, error: errMsg(e).slice(0, 120) });
    }
  }
  note(s, "candidates (ask gap to mark in bps, $ ask depth within 50 bps)", rows);
  if (!best) throw new Error("no thin market found");
  note(s, "chosen", best);
  return best;
}

async function bandRefusal(s: Scenario) {
  const sid = await traderSourceId();
  const thin = await thinMarket(s);
  await send(s, "FOLLOWER", `follower: approve hub on ${thin.symbol}`, {
    address: OPERATOR_REGISTRY,
    abi: registryAbi,
    functionName: "setOperatorApprovalForPool",
    args: [thin.pool, HUB, [PLACE_ORDER_FOR], true],
  });
  await send(s, "FOLLOWER", "follower: band 5 bps", {
    address: HUB,
    abi: hubAbi,
    functionName: "updatePolicy",
    args: [policy({ scaleBps: 10_000, bandBps: 5 })],
  });
  const qty = BigInt(thin.minQty);
  const t = await leaderTrade(s, `leader buys ${thin.symbol} min size`, thin.pool, true, qty);
  const rx = await copied(s, `band refusal on ${thin.symbol}`, t, FOLLOWER, (evs) => evs.some((e) => e.eventName === "Refused" || e.eventName === "Copied"));
  const refused = rx?.events.find((e) => e.eventName === "Refused");
  note(s, "venueError (live FOK no-fill revert)", refused?.args.venueError);
  check(s, !!refused && Number(refused.args.reason) === BAND_REFUSED, "Refused(BandUnfilled)");
  check(s, refused?.args.venueError === "0xc04ad919", "venue error is FillOrKillNotFillable() 0xc04ad919");
  check(s, refused?.args.sourceId === sid && getAddress(refused?.args.pool as Address) === thin.pool, "refusal names the source and market");
  check(s, (await size(FOLLOWER, thin.pool)) === 0n, `follower holds no ${thin.symbol}`);

  const close = await leaderTrade(s, `leader closes ${thin.symbol}`, thin.pool, false, qty);
  const runs = await handlerTxs(close.blockNumber, 3);
  note(s, "handler runs after the leader's close (follower flat: silent no-op)", runs.map((r) => ({ ...r, gasUsed: Number(r.gasUsed) })));
  if (runs[0]) proof.measurements.noopTraderMemberHandlerGas = Number(runs[0].gasUsed);
  await send(s, "FOLLOWER", "follower: band back to 50 bps", {
    address: HUB,
    abi: hubAbi,
    functionName: "updatePolicy",
    args: [TRADER_POLICY],
  });
}

async function theme(s: Scenario) {
  const legs1 = [
    { pool: pools.BTC, weightBps: 5_000 },
    { pool: pools.ETH, weightBps: -5_000 },
  ];
  const created = await send(s, "HUB_OWNER", 'owner: createTheme "BTC vs ETH" (+5000 / -5000)', {
    address: THEMES,
    abi: themesAbi,
    functionName: "createTheme",
    args: ["BTC vs ETH", "", legs1],
  });
  const themeId = (await pub.readContract({ address: THEMES, abi: themesAbi, functionName: "themeCount" })) as bigint;
  note(s, "themeId", themeId);
  const createdAt = (await pub.getBlock({ blockNumber: created.blockNumber })).timestamp;

  // allocation 80: the rebalance moves each leg by 20% of it, which must clear BTC's 0.00013 and ETH's 0.004 minimums
  const p = policy({ allocation: parseEther("80"), maxNotional: parseEther("100"), bandBps: 50 });
  const f = await send(s, "FOLLOWER2", "follower2: follow theme (allocation 80, band 50, tank 1 STT; global grant only)", {
    address: HUB,
    abi: hubAbi,
    functionName: "follow",
    args: [THEME, themeId, p, []],
    value: parseEther("1"),
  });
  const fe = decodeHub(f.logs);
  for (const e of fe) console.log(`    ${fmtEvent(e)}`);
  const opened = fe.find((e) => e.eventName === "GroupOpened");
  note(s, "theme group", { relay: opened?.args.relay, subscriptionId: String(opened?.args.subscriptionId) });
  const copies = (evs: HubEvent[]) => evs.filter((e) => e.eventName === "Copied");
  let legsTx = f;
  if (copies(fe).length < 2) {
    const refused = fe.filter((e) => e.eventName === "Refused").map(fmtEvent);
    note(s, "global grant alone: legs refused", refused);
    proof.measurements.globalGrantHonouredByPerps = false;
    for (const [sym, pool] of [["BTC", pools.BTC], ["ETH", pools.ETH]] as const) {
      await send(s, "FOLLOWER2", `follower2: approve hub on ${sym}`, {
        address: OPERATOR_REGISTRY,
        abi: registryAbi,
        functionName: "setOperatorApprovalForPool",
        args: [pool, HUB, [PLACE_ORDER_FOR], true],
      });
    }
    legsTx = await send(s, "FOLLOWER2", "follower2: resync (opens the basket)", { address: HUB, abi: hubAbi, functionName: "resync", args: [] });
  } else {
    proof.measurements.globalGrantHonouredByPerps = true;
  }
  const le = copies(decodeHub(legsTx.logs));
  for (const e of le) console.log(`    ${fmtEvent(e)}`);
  check(s, le.length === 2 && new Set(le.map((e) => e.args.pool)).size === 2, `both legs opened in one tx (${legsTx.transactionHash})`);
  const btc1 = await size(FOLLOWER2, pools.BTC);
  const eth1 = await size(FOLLOWER2, pools.ETH);
  note(s, "basket v1", { BTC: btc1, ETH: eth1 });
  check(s, btc1 > 0n && eth1 < 0n, "long BTC, short ETH");
  const sync1 = await hubRead<readonly [number, boolean]>("themeSyncOf", [FOLLOWER2]);
  check(s, Number(sync1[0]) === 1 && sync1[1], `themeSyncOf = (1, complete)`);

  // the registry allows one rebalance per 60 s
  for (;;) {
    const now = (await pub.getBlock()).timestamp;
    if (now >= createdAt + 62n) break;
    await sleep(Number(createdAt + 62n - now) * 1000);
  }
  const legs2 = [
    { pool: pools.BTC, weightBps: 7_000 },
    { pool: pools.ETH, weightBps: -3_000 },
  ];
  const rb = await send(s, "HUB_OWNER", "owner: rebalance to (+7000 / -3000)", {
    address: THEMES,
    abi: themesAbi,
    functionName: "rebalance",
    args: [themeId, legs2],
  });
  const rx = await copied(s, "theme rebalance", rb, FOLLOWER2, (evs) => copies(evs).length >= 2);
  const btc2 = await size(FOLLOWER2, pools.BTC);
  const eth2 = await size(FOLLOWER2, pools.ETH);
  note(s, "basket v2", { BTC: btc2, ETH: eth2 });
  check(s, btc2 > btc1 && eth2 < 0n && eth2 > eth1, "BTC leg grew, ETH leg shrank");
  const sync2 = await hubRead<readonly [number, boolean]>("themeSyncOf", [FOLLOWER2]);
  check(s, Number(sync2[0]) === 2 && sync2[1], "themeSyncOf = (2, complete)");
  if (rx) proof.measurements.themeMemberRebalance = { handlerGas: Number(rx.receipt.gasUsed), memberGas: await memberGas(rx.events, rx.receipt.blockNumber) };
}

async function equityFloor(s: Scenario) {
  const t = await leaderTrade(s, "leader buys 0.0005 BTC", pools.BTC, true, 50_000n);
  await copied(s, "open before the floor test", t, FOLLOWER, isCopy(pools.BTC, 50_000n));
  const eq = await equity(FOLLOWER);
  note(s, "follower equity", formatEther(eq));
  await send(s, "FOLLOWER", "follower: equity floor above equity", {
    address: HUB,
    abi: hubAbi,
    functionName: "updatePolicy",
    args: [policy({ scaleBps: 10_000, bandBps: 50, equityFloor: eq + parseEther("1000") })],
  });
  const pk = await send(s, "HUB_OWNER", "anyone: poke(follower)", { address: HUB, abi: hubAbi, functionName: "poke", args: [FOLLOWER] });
  const pe = decodeHub(pk.logs);
  for (const e of pe) console.log(`    ${fmtEvent(e)}`);
  check(s, pe.some((e) => e.eventName === "Stopped"), "Stopped emitted");
  check(s, pe.some((e) => e.eventName === "Copied" && e.args.toSize === 0n), "position closed in the poke tx");
  check(s, (await size(FOLLOWER, pools.BTC)) === 0n, "follower flat");
  const fo = await hubRead<readonly unknown[]>("followOf", [FOLLOWER]);
  check(s, fo[4] === true, "follow paused");
  proof.measurements.pokeStopGas = Number(pk.gasUsed);

  await send(s, "FOLLOWER", "follower: floor lowered to 1 USDso", {
    address: HUB,
    abi: hubAbi,
    functionName: "updatePolicy",
    args: [policy({ scaleBps: 10_000, bandBps: 50, equityFloor: parseEther("1") })],
  });
  const rs = await send(s, "FOLLOWER", "follower: resume()", { address: HUB, abi: hubAbi, functionName: "resume", args: [] });
  check(s, decodeHub(rs.logs).some((e) => e.eventName === "Resumed"), "Resumed emitted");
  const fo2 = await hubRead<readonly unknown[]>("followOf", [FOLLOWER]);
  check(s, fo2[4] === false, "follow running again");

  const close = await leaderTrade(s, "leader sells 0.0005 BTC (follower already flat)", pools.BTC, false, 50_000n);
  const runs = await handlerTxs(close.blockNumber, 3);
  note(s, "handler runs after the close (silent no-op member)", runs.map((r) => ({ ...r, gasUsed: Number(r.gasUsed) })));
  check(s, runs.some((r) => r.block === close.blockNumber && r.status === "success"), "handler ran in the close's block");
  check(s, (await size(FOLLOWER, pools.BTC)) === 0n, "follower still flat");
}

async function unsubscribe(s: Scenario) {
  const sid = await traderSourceId();
  const oldId = await hubRead<bigint>("subscriptionOf", [sid, 0]);
  note(s, "group 0 subscription before", oldId);
  const r = await send(s, "FOLLOWER", "follower: unfollow(flatten) - last member of group 0", {
    address: HUB,
    abi: hubAbi,
    functionName: "unfollow",
    args: [true],
  });
  const evs = decodeHub(r.logs);
  for (const e of evs) console.log(`    ${fmtEvent(e)}`);
  const closed = evs.find((e) => e.eventName === "GroupClosed");
  note(s, "precompile events", precompileEvents(r));
  check(s, closed?.args.cancelled === true, "precompile accepted the hub's unsubscribe (GroupClosed.cancelled)");
  check(s, precompileEvents(r).some((e) => e.eventName === "SubscriptionRemoved"), "SubscriptionRemoved emitted");
  const info = await subscriptionInfo(oldId);
  note(s, "getSubscriptionInfo(removed id)", info);
  proof.measurements.getSubscriptionInfoRemovedId = info;
  check(s, (await hubRead<boolean>("subscribed", [sid, 0])) === false, "group 0 marked unsubscribed");
  const es = await send(s, "HUB_OWNER", "anyone: ensureSubscribed(source, 0) on the empty group", {
    address: HUB,
    abi: hubAbi,
    functionName: "ensureSubscribed",
    args: [sid, 0],
  });
  check(s, es.logs.length === 0, "ensureSubscribed leaves an empty group alone (no logs)");
}

async function guaranteed(s: Scenario) {
  const sp = await hubRead<readonly unknown[]>("subParams");
  note(s, "subParams before", sp);
  await send(s, "HUB_OWNER", "owner: setSubParams(isGuaranteed = true)", {
    address: HUB,
    abi: hubAbi,
    functionName: "setSubParams",
    args: [0n, 20_000_000_000n, 200_000_000n, 200_000_000n, true],
  });
  let r: TransactionReceipt | undefined;
  try {
    r = await send(s, "FOLLOWER", "follower: follow leader again (group 0 subscribes with isGuaranteed)", {
      address: HUB,
      abi: hubAbi,
      functionName: "follow",
      args: [TRADER, BigInt(LEADER), TRADER_POLICY, []],
      value: parseEther("0.2"),
    });
  } catch (e) {
    note(s, "follow with isGuaranteed rejected", errMsg(e));
    proof.measurements.isGuaranteedAccepted = false;
  }
  if (!r) {
    check(s, false, "precompile accepts isGuaranteed = true");
    await send(s, "HUB_OWNER", "owner: setSubParams(isGuaranteed = false)", {
      address: HUB,
      abi: hubAbi,
      functionName: "setSubParams",
      args: [0n, 20_000_000_000n, 200_000_000n, 200_000_000n, false],
    });
    await send(s, "FOLLOWER", "follower: follow leader again", {
      address: HUB,
      abi: hubAbi,
      functionName: "follow",
      args: [TRADER, BigInt(LEADER), TRADER_POLICY, []],
      value: parseEther("0.2"),
    });
    return;
  }
  const opened = decodeHub(r.logs).find((e) => e.eventName === "GroupOpened");
  const pe = precompileEvents(r);
  note(s, "precompile events", pe);
  const id = opened?.args.subscriptionId as bigint;
  const info = await subscriptionInfo(id);
  note(s, "getSubscriptionInfo(new id)", info);
  const g = info.ok ? (info.sub as { isGuaranteed?: boolean }).isGuaranteed : undefined;
  proof.measurements.isGuaranteedAccepted = g === true;
  check(s, g === true, "precompile stored isGuaranteed = true, owner hub");

  const t1 = await leaderTrade(s, "leader buys 0.0005 BTC", pools.BTC, true, 50_000n);
  await copied(s, "guaranteed sub: open", t1, FOLLOWER, isCopy(pools.BTC, 50_000n));
  const t2 = await leaderTrade(s, "leader sells 0.0005 BTC", pools.BTC, false, 50_000n);
  await copied(s, "guaranteed sub: close", t2, FOLLOWER, isCopy(pools.BTC, 0n));
  check(s, (await size(FOLLOWER, pools.BTC)) === 0n, "follower flat");
}

/** R40: the handler floor covers the largest single exit measured live plus EXIT_MARK_GAS and a margin. */
async function gasTuning(s: Scenario) {
  const exits = proof.sameBlock
    .filter((e) => e.memberGas !== undefined && e.logs?.some((l) => l.startsWith("Copied") && /toSize=0[,)]/.test(l)))
    .map((e) => ({ label: e.label, memberGas: e.memberGas!, handlerGas: e.handlerGas! }));
  note(s, "measured exits (member gas from TankCharged)", exits);
  const all = proof.sameBlock.filter((e) => e.memberGas !== undefined).map((e) => ({ label: e.label, memberGas: e.memberGas!, handlerGas: e.handlerGas! }));
  note(s, "all measured member syncs", all);
  const maxExit = BigInt(Math.max(...exits.map((e) => e.memberGas)));
  const gp = await gasParams();
  note(s, "gasParams before", gp);
  // measured exits are one-level fills (~1.4M per order); the venue documents orders up to ~7.7M on Hideki, so the
  // margin leaves room for an exit that walks the book
  const margin = 6_000_000n;
  const need = maxExit + EXIT_MARK_GAS + margin;
  let floor = ((need + 999_999n) / 1_000_000n) * 1_000_000n;
  if (floor < gp.floor) floor = gp.floor;
  note(s, "R40 floor", { maxExit, exitMark: EXIT_MARK_GAS, margin, need, floor });
  proof.measurements.r40 = { maxExit: Number(maxExit), need: Number(need), floor: Number(floor) };

  // chargeOverhead: what a handler run costs beyond the member's own measured phases (one-member groups, so this is
  // the whole relay, event check and charge around it: an upper bound on one member's share)
  const residual = all.map((e) => e.handlerGas - e.memberGas);
  const maxResidual = BigInt(Math.max(...residual));
  let overhead = ((maxResidual + 9_999n) / 10_000n) * 10_000n;
  if (overhead < 20_000n) overhead = 20_000n;
  note(s, "handler gas beyond the member's phases", { residual, chargeOverhead: overhead });
  proof.measurements.chargeOverhead = { residual, set: Number(overhead) };

  // per-phase fixed cost of a member with nothing to do, as the hub's own call (includes 21k intrinsic)
  const sid = await traderSourceId();
  const est = async (fn: string) =>
    Number(
      await pub.estimateContractGas({
        account: HUB,
        address: HUB,
        abi: hubAbi,
        functionName: fn,
        args: [sid, FOLLOWER, pools.BTC, 0n, [], 0],
      } as never),
    );
  proof.measurements.noopPhaseEstimates = { exitFromEvent: await est("exitFromEvent"), entryFromEvent: await est("entryFromEvent") };
  note(s, "no-op phase estimates (from hub)", proof.measurements.noopPhaseEstimates);

  await send(s, "HUB_OWNER", `owner: setGasParams(floor ${floor}, chargeOverhead ${overhead})`, {
    address: HUB,
    abi: hubAbi,
    functionName: "setGasParams",
    args: [floor, gp.perFollowerCap, gp.themePerFollowerCap, gp.tailBase, gp.perDefer, overhead],
  });
  const after = await gasParams();
  note(s, "gasParams after", after);
  check(s, after.floor === floor && after.chargeOverhead === overhead, "floor and chargeOverhead set");

  const t1 = await leaderTrade(s, "leader buys 0.0005 BTC", pools.BTC, true, 50_000n);
  await copied(s, "after setGasParams: open", t1, FOLLOWER, isCopy(pools.BTC, 50_000n));
  const t2 = await leaderTrade(s, "leader sells 0.0005 BTC", pools.BTC, false, 50_000n);
  await copied(s, "after setGasParams: close", t2, FOLLOWER, isCopy(pools.BTC, 0n));
}

/** Handler cost after the follower's keys sat idle, against the warm runs above (Somnia prices a cold key ~1M). */
async function idle(s: Scenario) {
  const last = proof.sameBlock.filter((e) => e.handlerBlock).at(-1);
  if (last) {
    const [then, now] = await Promise.all([pub.getBlock({ blockNumber: BigInt(last.handlerBlock!) }), pub.getBlock()]);
    note(s, "seconds since the last handler run", Number(now.timestamp - then.timestamp));
  }
  const t1 = await leaderTrade(s, "leader buys 0.0005 BTC", pools.BTC, true, 50_000n);
  const a = await copied(s, "after idle: open", t1, FOLLOWER, isCopy(pools.BTC, 50_000n));
  const t2 = await leaderTrade(s, "leader sells 0.0005 BTC", pools.BTC, false, 50_000n);
  const b = await copied(s, "after idle: close", t2, FOLLOWER, isCopy(pools.BTC, 0n));
  proof.measurements.idleRuns = {
    open: a && { handlerGas: Number(a.receipt.gasUsed), memberGas: await memberGas(a.events, a.receipt.blockNumber) },
    close: b && { handlerGas: Number(b.receipt.gasUsed), memberGas: await memberGas(b.events, b.receipt.blockNumber) },
  };
}

async function summary(s: Scenario) {
  const withHandler = proof.sameBlock.filter((e) => e.handler);
  const sameBlock = withHandler.filter((e) => e.delta === 0).length;
  proof.measurements.sameBlockRatio = `${sameBlock}/${proof.sameBlock.length}`;
  note(s, "same-block ratio (hub reaction in the trigger's block / triggers)", proof.measurements.sameBlockRatio);
  note(s, "handler origin == hub", withHandler.every((e) => e.handlerFrom && getAddress(e.handlerFrom) === HUB));
  const bal: Record<string, unknown> = {};
  for (const [k, a] of Object.entries({ OWNER, LEADER, FOLLOWER, FOLLOWER2, HUB })) {
    bal[k] = { stt: formatEther(await pub.getBalance({ address: a })), margin: formatEther(await equity(a)) };
  }
  bal.tanks = {
    follower: formatEther(await hubRead<bigint>("tankOf", [FOLLOWER])),
    follower2: formatEther(await hubRead<bigint>("tankOf", [FOLLOWER2])),
    total: formatEther(await hubRead<bigint>("totalTanks")),
  };
  bal.usdsoOwner = formatEther(await pub.readContract({ address: USDSO, abi: erc20Abi, functionName: "balanceOf", args: [OWNER] }));
  proof.measurements.balancesAfter = bal;
  note(s, "balances", bal);
  check(s, sameBlock === proof.sameBlock.length, "every trigger copied in its own block");
}

const ALL: [string, (s: Scenario) => Promise<void>][] = [
  ["setup", setup],
  ["approvals", approvals],
  ["follow", follow],
  ["open", (s) => openClose(s, "open")],
  ["close", (s) => openClose(s, "close")],
  ["sameblock", moreTrades],
  ["band", bandRefusal],
  ["theme", theme],
  ["floor", equityFloor],
  ["unsubscribe", unsubscribe],
  ["guaranteed", guaranteed],
  ["gas", gasTuning],
  ["idle", idle],
  ["summary", summary],
];

async function main() {
  const only = process.argv.slice(2);
  const run = only.length ? ALL.filter(([n]) => n === "setup" || only.includes(n)) : ALL;
  for (const [name, fn] of run) await scenario(name, fn);
}

main()
  .catch((e) => {
    console.error(e instanceof Abort ? `ABORTED: ${e.message}` : e);
    process.exitCode = 1;
  })
  .finally(() => {
    saveProof();
    setTimeout(() => process.exit(), 500);
  });
