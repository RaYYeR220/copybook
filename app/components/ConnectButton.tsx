"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EIP1193Provider } from "viem";
import { useAccount, useConnect, useDisconnect, useSwitchChain, type Connector } from "wagmi";
import { shortHex } from "@/lib/format";
import { addHidekiToWallet, isUserRejection } from "@/lib/wallet/addNetwork";
import { hideki } from "@/lib/wallet/hideki";
import { Button } from "./Button";
import styles from "./ConnectButton.module.css";

/** EIP-6963 wallets announce themselves; the generic `injected` connector only stands in when none did. */
function useWalletConnectors(): readonly Connector[] {
  const { connectors } = useConnect();
  return useMemo(() => {
    const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
    return announced.length ? announced : connectors;
  }, [connectors]);
}

function errorText(err: unknown): string | null {
  if (!err || isUserRejection(err)) return null;
  const e = err as { shortMessage?: string; message?: string };
  return e.shortMessage ?? e.message ?? "The wallet returned an error.";
}

/**
 * Wallet state for the app bar: connect (choosing among announced wallets), switch to the network (adding it
 * to the wallet first when it is missing), or show the network and the connected account.
 */
export function ConnectButton({ inline = false }: { inline?: boolean } = {}) {
  const who = inline ? `${styles.who} ${styles.inline}` : styles.who;
  const { address, chainId, connector, status } = useAccount();
  const { connect, isPending: connecting, error: connectError, reset } = useConnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const { disconnect } = useDisconnect();
  const wallets = useWalletConnectors();
  const [choosing, setChoosing] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [noWallet, setNoWallet] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  // The generic connector exists even without a wallet; only the browser can tell whether one is there.
  useEffect(() => {
    const announced = wallets.some((w) => w.id !== "injected");
    setNoWallet(!announced && !(window as { ethereum?: unknown }).ethereum);
  }, [wallets]);

  useEffect(() => {
    if (!choosing) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menu.current?.contains(e.target as Node)) setChoosing(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [choosing]);

  const message = addError ?? errorText(connectError) ?? errorText(switchError);

  // a returning wallet is "reconnecting" from the cookie on the first render: show it, don't flash "Connect"
  if ((status === "connected" || status === "reconnecting") && address) {
    if (chainId !== hideki.id) {
      const addThenSwitch = async () => {
        setAddError(null);
        try {
          const provider = (await connector?.getProvider()) as EIP1193Provider | undefined;
          if (provider && (await addHidekiToWallet(provider))) switchChain({ chainId: hideki.id });
        } catch (err) {
          setAddError(errorText(err));
        }
      };
      return (
        <div className={who}>
          <Button size="md" onClick={() => switchChain({ chainId: hideki.id })} disabled={switching}>
            {switching ? (
              "Check your wallet…"
            ) : (
              <>
                Switch <span className={styles.long}>to {hideki.name}</span>
                <span className={styles.short}>network</span>
              </>
            )}
          </Button>
          <Button size="md" variant="quiet" onClick={addThenSwitch} className={styles.add}>
            Add {hideki.name} to wallet
          </Button>
          {message && <p className={styles.err} role="alert">{message}</p>}
        </div>
      );
    }
    return (
      <div className={who}>
        <span className={`${styles.chip} ${styles.net}`}>
          <i aria-hidden="true" />
          {hideki.name}
        </span>
        <button className={styles.chip} type="button" onClick={() => disconnect()} title="Disconnect this wallet">
          <i aria-hidden="true" />
          <span className="mono">{shortHex(address)}</span>
          <span className="sr-only">, disconnect</span>
        </button>
      </div>
    );
  }

  if (noWallet || !wallets.length) {
    return (
      <div className={who}>
        <Button size="md" variant="quiet" href="https://rabby.io">
          Install a wallet
        </Button>
      </div>
    );
  }

  const start = () => {
    reset();
    setAddError(null);
    if (wallets.length === 1) connect({ connector: wallets[0] });
    else setChoosing((v) => !v);
  };

  return (
    <div className={who} ref={menu}>
      <Button size="md" onClick={start} disabled={connecting} aria-expanded={wallets.length > 1 ? choosing : undefined}>
        {connecting ? "Check your wallet…" : "Connect wallet"}
      </Button>
      {choosing && (
        <ul className={styles.menu} aria-label="Choose a wallet">
          {wallets.map((w) => (
            <li key={w.uid}>
              <button
                type="button"
                className={styles.option}
                onClick={() => {
                  setChoosing(false);
                  connect({ connector: w });
                }}
              >
                {w.icon && <img src={w.icon} alt="" width={16} height={16} />}
                {w.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && <p className={styles.err} role="alert">{message}</p>}
    </div>
  );
}
