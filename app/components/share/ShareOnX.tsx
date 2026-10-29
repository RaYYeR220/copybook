"use client";

import { useEffect, useRef, useState, type Ref } from "react";
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

export type CopyState = "idle" | "done" | "failed";

/** How long "Copied" stays up. */
export const COPIED_MS = 3_000;

/** Two quiet pills: post this page on X (a new tab), and copy its link. */
export function ShareOnX({ text, url, subject }: Props) {
  const [state, setState] = useState<CopyState>("idle");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state === "done") {
      const t = setTimeout(() => setState("idle"), COPIED_MS);
      return () => clearTimeout(t);
    }
    // the browser would not write the clipboard: the link is selected, ready for the keyboard's copy
    if (state === "failed") {
      field.current?.focus();
      field.current?.select();
    }
  }, [state]);
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
      <CopyStatus state={state} url={url} subject={subject} field={field} />
    </div>
  );
}

/** "Copied", or when the browser refused, the link itself in a field to select and copy. */
export function CopyStatus({ state, url, subject, field }: { state: CopyState; url: string; subject: string; field?: Ref<HTMLInputElement> }) {
  return (
    <>
      <span className={styles.status} role="status" aria-live="polite">
        {state === "done" ? "Copied" : state === "failed" ? "Not copied: select the link and copy it" : ""}
      </span>
      {state === "failed" && (
        <input ref={field} className={styles.field} type="text" readOnly value={url} aria-label={`Link to ${subject}`} onFocus={(e) => e.currentTarget.select()} />
      )}
    </>
  );
}

/** ShareOnX in the owner's words when the connected wallet is `owner` (the follower, the trader, the creator). */
export function OwnerShareOnX({ owner, ownText, ...props }: Props & { owner: string; ownText: string }) {
  const { address } = useAccount();
  const own = !!address && address.toLowerCase() === owner.toLowerCase();
  return <ShareOnX {...props} text={own ? ownText : props.text} />;
}
