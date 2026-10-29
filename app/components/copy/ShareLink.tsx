"use client";

import { OwnerShareOnX } from "@/components/share/ShareOnX";
import styles from "./Copy.module.css";

/** The page's address, to paste anywhere the card should show, and the post for X: the follower's own words when it is their wallet. */
export function ShareLink({ path, url, text, ownText, follower }: { path: string; url: string; text: string; ownText: string; follower: string }) {
  return (
    <div className={styles.share}>
      <code className={styles.url}>{path}</code>
      <OwnerShareOnX owner={follower} ownText={ownText} text={text} url={url} subject="this copy" />
    </div>
  );
}
