"use client";

import { useMemo } from "react";
import type { Address, PublicClient } from "viem";
import type { Copybook, Leg } from "@copybook/sdk";
import { checkBasket, parseRows, type BasketIssue, type BasketRow, type RegistryRules } from "@/lib/builder/basket";
import { basketMinimum } from "@/lib/builder/registry";
import type { MarketMeta } from "@/lib/tape";
import { useMarketReads, useRegistration } from "./hooks";
import { marketLabel } from "./LegsEditor";

export interface BasketContext {
  cb: Copybook;
  client: PublicClient;
  bank: Address | null;
  markets: Record<string, MarketMeta>;
  registered: Record<string, boolean>;
  rules: RegistryRules;
}

/** The registry's verdict on a set of legs: `checkBasket` for a new thesis, `checkRebalance` for a change. */
export type LegCheck = (legs: Leg[], registration: Record<string, boolean | undefined>, label: (pool: Address) => string) => BasketIssue[];

/**
 * Everything the form derives from its rows: the legs, the registry's verdict on them (issues mapped back to form
 * rows), each market read live, and the minimum allocation at those marks.
 */
export function useBasket(rows: readonly BasketRow[], ctx: BasketContext, check?: LegCheck) {
  const parsed = useMemo(() => parseRows(rows), [rows]);
  const pools = useMemo(() => rows.filter((r) => r.pool).map((r) => r.pool as Address), [rows]);
  const registration = useRegistration(ctx.client, ctx.bank, pools, ctx.registered);
  const { reads, readAt } = useMarketReads(ctx.cb, pools);
  const label = (pool: Address) => marketLabel(ctx.markets, pool);

  // registry issues are per leg; the form shows them on the row the leg came from
  const raw = check ? check(parsed.legs, registration, label) : checkBasket(parsed.legs, ctx.rules, registration, label);
  const legIssues = raw.map((x): BasketIssue => ({ ...x, row: x.row === undefined ? undefined : parsed.rowOf[x.row], fix: x.fix && { ...x.fix, row: parsed.rowOf[x.fix.row] } }));
  // rows that are not legs yet already say so: no NoLegs on top of them
  const issues = [...parsed.issues, ...legIssues].filter((x) => !(x.code === "NoLegs" && parsed.issues.length > 0));
  const rowIssues = new Map<number, BasketIssue[]>();
  for (const x of issues) if (x.row !== undefined) rowIssues.set(x.row, [...(rowIssues.get(x.row) ?? []), x]);
  const minimum = basketMinimum(parsed.legs, reads);
  return { parsed, issues, rowIssues, reads, readAt, minimum, registration, label };
}
