import Link from "next/link";
import { shortHex } from "@/lib/format";
import { config } from "@/lib/server/config";
import type { Thesis } from "@/lib/server/theses";
import type { MarketMeta } from "@/lib/tape";
import { legSide } from "@/lib/thesis";
import { fmtUsd18 } from "@/lib/units";
import styles from "./ThesisList.module.css";

const name = (markets: Record<string, MarketMeta>, pool: string) => {
  const m = markets[pool.toLowerCase()];
  return m ? `${m.symbol}-PERP` : shortHex(pool);
};

/**
 * The ThemeRegistry's theses: name, legs by side and weight, version, and the smallest allocation at live marks. A
 * thesis published from a wallet Copybook runs is marked ours.
 */
export function ThesisList({ theses, markets }: { theses: Thesis[]; markets: Record<string, MarketMeta> }) {
  return (
    <ul className={styles.list}>
      {theses.map((t) => (
        <li key={t.id.toString()} className={styles.item}>
          <div className={styles.head}>
            <Link href={`/thesis/${t.id}`} className={styles.name} prefetch={false}>
              {t.name}
            </Link>
            <span className={styles.ver}>
              #{t.id.toString()} · v{t.version}
              {config.isOurs(t.creator) && <span className={styles.ours}> · ours</span>}
            </span>
          </div>
          <p className={styles.legs}>
            {t.legs.map((l, i) => {
              const s = legSide(l.weightBps);
              return (
                <span key={l.pool}>
                  {i > 0 && <span className={styles.sep}> · </span>}
                  <b>{name(markets, l.pool)}</b> {s.side} {s.pct}
                </span>
              );
            })}
          </p>
          <p className={styles.min}>
            {t.minimum ? (
              <>
                from <b>{fmtUsd18(t.minimum.allocation, "up")}</b> at today&apos;s marks · {fmtUsd18(t.minimum.recommended, "up")} with headroom
              </>
            ) : (
              <>minimum unavailable: a leg&apos;s market could not be read</>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}
