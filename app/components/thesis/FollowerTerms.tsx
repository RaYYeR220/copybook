import f from "@/components/follow/Flow.module.css";

/**
 * What a follower's book does when a thesis is published and when it is rebalanced, as CopyEngine's theme sync
 * does it (`_themeExit`, then `_themeEntry` with `applyIncreases`).
 */
export function FollowerTerms({ rebalance = false }: { rebalance?: boolean }) {
  return (
    <div className={f.body}>
      <ul className={f.notes}>
        {rebalance ? (
          <li>
            <b>In the rebalance&apos;s own block</b> the hub&apos;s handler resyncs every follower. One whose turn runs out of handler gas is deferred; catchUp finishes it.
          </li>
        ) : (
          <li>
            <b>A follow sizes every leg</b> from the follower&apos;s allocation times its weight, short legs included, inside their cap per position.
          </li>
        )}
        <li>
          <b>Reductions first, never gated:</b> a leg that shrinks, a dropped leg and the old side of a flipped leg are cut back whatever the follower&apos;s caps or tank say. If the
          venue cannot fill one inside the exit band it stays open, and the dashboard offers catchUp.
        </li>
        <li>
          <b>Then every increase as one set, all or nothing:</b> if one leg cannot open (below the venue&apos;s minimum order at the follower&apos;s allocation, or no fill inside their
          band), none of the increases go through, and the refusal names the leg.
        </li>
        <li>
          <b>A leg within 5% of its target is left alone.</b> Between versions the legs drift with prices; the follower&apos;s resync brings them back to weight.
        </li>
        <li>
          <b>No AI guard on theses:</b> the validators&apos; verdict gates trader follows only.
        </li>
      </ul>
    </div>
  );
}
