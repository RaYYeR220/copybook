"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, http, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { useConnect, useWalletClient } from "wagmi";
import { createCopybook, CopybookError, type Copybook, type PreflightInput, type PreflightResult } from "@copybook/sdk";
import { IDLE, forgetTx, recallTx, rememberTx, runTx, type Sent, type TxPhase } from "@/lib/follow/tx";

export { txFor } from "@/lib/follow/tx";
import { deploymentsOf, type PublicConfig } from "@/lib/publicConfig";
import { hideki } from "@/lib/wallet/hideki";

/** A read-only client on Hideki, made once per page. */
export function useReader(pub: PublicConfig) {
  const hub = (pub.deployments as { hub?: string }).hub ?? "";
  const pubRef = useRef(pub);
  pubRef.current = pub;
  return useMemo(() => {
    const deployments = deploymentsOf(pubRef.current);
    const publicClient = createPublicClient({ chain: hideki, transport: http(undefined, { retryCount: 2, timeout: 20_000 }) }) as PublicClient;
    return { deployments, publicClient, copybook: createCopybook({ publicClient, deployments }) };
  }, [hub]);
}

/** A client that signs with the connected wallet, built when a button is pressed. */
export function useWriter(reader: ReturnType<typeof useReader>) {
  const { data: walletClient } = useWalletClient();
  return useCallback((): Copybook => {
    if (!walletClient) throw new CopybookError("NO_WALLET", "Connect a wallet to send transactions.");
    return createCopybook({ publicClient: reader.publicClient, walletClient: walletClient as WalletClient, deployments: reader.deployments });
  }, [walletClient, reader]);
}

/** Whether the browser has an injected wallet at all (the generic connector exists either way). */
export function useWalletInstalled(): boolean {
  const { connectors } = useConnect();
  const [installed, setInstalled] = useState(true);
  useEffect(() => {
    const announced = connectors.some((c) => c.type === "injected" && c.id !== "injected");
    setInstalled(announced || !!(window as { ethereum?: unknown }).ethereum);
  }, [connectors]);
  return installed;
}

const session = (): Storage | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
};

/**
 * The page's one transaction at a time, per wallet. A sent hash is kept in session storage until it lands, so a
 * reload waits for it instead of offering to send it again. `onLanded` runs after every confirmed (or recalled
 * and confirmed) transaction, to re-read the chain.
 */
export function useTx(address: Address | undefined, publicClient: PublicClient, onLanded: () => void) {
  const [tx, setTx] = useState<TxPhase>(IDLE);
  const [recalled, setRecalled] = useState(false);
  const landed = useRef(onLanded);
  landed.current = onLanded;
  const owner = useRef<string | undefined>(address);

  // another account: its own transactions only
  useEffect(() => {
    owner.current = address;
    setTx(IDLE);
    setRecalled(false);
    if (!address) return;
    const kept = recallTx(session(), address, Math.floor(Date.now() / 1000));
    if (!kept) return;
    let live = true;
    setRecalled(true);
    setTx({ phase: "pending", action: kept.action, hash: kept.hash });
    publicClient
      .waitForTransactionReceipt({ hash: kept.hash, timeout: 120_000, pollingInterval: 1_000 })
      .then((r) => {
        if (!live || owner.current !== address) return;
        forgetTx(session(), address);
        setTx(
          r.status === "success"
            ? { phase: "confirmed", action: kept.action, hash: kept.hash, block: r.blockNumber }
            : { phase: "failed", action: kept.action, hash: kept.hash, message: "The transaction reverted on chain. Nothing changed; the page re-reads the chain." },
        );
        landed.current();
      })
      .catch(() => {
        // not seen within the wait: the chain reads decide the step, and the next load forgets it after its age
        if (live && owner.current === address) setTx(IDLE);
      });
    return () => {
      live = false;
    };
  }, [address, publicClient]);

  const run = useCallback(
    async (action: string, send: () => Promise<Sent>): Promise<TxPhase> => {
      const who = address;
      setRecalled(false);
      const out = await runTx(
        action,
        send,
        (p) => owner.current === who && setTx(p),
        (hash: Hex) => who && rememberTx(session(), { address: who, action, hash, at: Math.floor(Date.now() / 1000) }),
      );
      if (who) forgetTx(session(), who);
      if (out.phase === "confirmed" || (out.phase === "failed" && out.hash)) landed.current();
      return out;
    },
    [address],
  );

  const busy = tx.phase === "signing" || tx.phase === "pending";
  return { tx, recalled, run, busy, reset: () => setTx(IDLE) };
}

export type PreflightState =
  | { status: "idle" }
  | { status: "checking"; last?: PreflightResult }
  | { status: "ready"; result: PreflightResult; key: string }
  | { status: "error"; error: string; last?: PreflightResult };

/**
 * The SDK's preflight, run again 350 ms after the inputs stop changing. Only the answer for the latest inputs is
 * kept, so a slow read for an older policy never replaces a newer one.
 */
export function usePreflight(cb: Copybook, input: PreflightInput | null, key: string): PreflightState {
  const [state, setState] = useState<PreflightState>({ status: "idle" });
  const seq = useRef(0);
  const inputRef = useRef(input);
  inputRef.current = input;
  useEffect(() => {
    const now = inputRef.current;
    const n = ++seq.current;
    if (!now) {
      setState({ status: "idle" });
      return;
    }
    setState((s) => ({ status: "checking", last: s.status === "ready" ? s.result : s.status === "checking" || s.status === "error" ? s.last : undefined }));
    const t = setTimeout(() => {
      cb.preflightFollow(now).then(
        (result) => n === seq.current && setState({ status: "ready", result, key }),
        (err) => n === seq.current && setState((s) => ({ status: "error", error: err instanceof Error ? err.message : String(err), last: s.status === "checking" ? s.last : undefined })),
      );
    }, 350);
    return () => clearTimeout(t);
  }, [cb, key]);
  return state;
}
