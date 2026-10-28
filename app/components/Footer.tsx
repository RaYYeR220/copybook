import { DREAMDEX_URL, REPO_URL, SCORECARD_URL } from "@/content/site";
import { deployments } from "@/lib/deployments";
import { addressUrl } from "@/lib/explorer";
import { shortHex } from "@/lib/format";
import { Wordmark } from "./Nav";
import styles from "./Footer.module.css";

export function Footer() {
  const hub = deployments.hub;
  return (
    <footer className={styles.foot}>
      <div>
        <Wordmark />
        <p className={styles.built}>Built for dreamDEX perps on Somnia.</p>
      </div>
      <nav className={styles.links} aria-label="Footer">
        <a href={REPO_URL} rel="noopener noreferrer">
          Source
        </a>
        <a href={SCORECARD_URL} rel="noopener noreferrer">
          AI guard scorecard
        </a>
        <a href={DREAMDEX_URL} rel="noopener noreferrer">
          dreamDEX
        </a>
        <a href={addressUrl(hub)} rel="noopener noreferrer">
          Hub on the explorer
        </a>
      </nav>
      <div className={styles.fine}>
        <span>Hub {shortHex(hub)} · Somnia testnet</span>
        <span>Every refusal is written on-chain with its reason</span>
        <span>© 2026 Copybook</span>
      </div>
    </footer>
  );
}
