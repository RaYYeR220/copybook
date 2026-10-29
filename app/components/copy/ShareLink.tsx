"use client";

import { useState } from "react";
import styles from "./Copy.module.css";

/** The page's address, to paste anywhere the card should show. */
export function ShareLink({ path }: { path: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).toString());
      setState("done");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className={styles.share}>
      <code className={styles.url}>{path}</code>
      <button type="button" className={styles.copyBtn} onClick={copy}>
        Copy link
      </button>
      <span className={styles.copied} role="status" aria-live="polite">
        {state === "done" ? "Copied" : state === "failed" ? "The browser refused; copy it from the address bar" : ""}
      </span>
    </div>
  );
}
