"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { xIntentUrl } from "@/lib/share";
import styles from "./Share.module.css";

interface Props {
  /** The post, without the link (X adds the link after it). */
  text: string;
  /** The page's absolute address: its card is the proof that comes with the post. */
  url: string;
  /** What is shared, for screen readers: "this copy", "this trader's page". */
  subject: string;
}

/** Two quiet pills: post this page on X (a new tab), and copy its link. */
export function ShareOnX({ text, url, subject }: Props) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setState("done");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className={styles.row} role="group" aria-label={`Share ${subject}`}>
      <a className={styles.pill} href={xIntentUrl(text, url)} target="_blank" rel="noopener noreferrer" aria-label={`Share on X: ${subject} (opens in a new tab)`}>
        Share on X <span aria-hidden="true">↗</span>
      </a>
      <button type="button" className={styles.pill} onClick={copy} aria-label={`Copy link to ${subject}`}>
        Copy link
      </button>
      <span className={styles.status} role="status" aria-live="polite">
        {state === "done" ? "Copied" : state === "failed" ? "The browser refused; copy it from the address bar" : ""}
      </span>
    </div>
  );
}

/** ShareOnX in the owner's words when the connected wallet is `owner` (the follower, the trader, the creator). */
export function OwnerShareOnX({ owner, ownText, ...props }: Props & { owner: string; ownText: string }) {
  const { address } = useAccount();
  const own = !!address && address.toLowerCase() === owner.toLowerCase();
  return <ShareOnX {...props} text={own ? ownText : props.text} />;
}
