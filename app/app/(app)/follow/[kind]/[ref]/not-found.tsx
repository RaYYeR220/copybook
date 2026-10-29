import { NotFoundSource } from "@/components/app/NotFoundSource";

/** A follow link that names nothing: a kind other than trader or thesis, a bad address or id, or a missing thesis. */
export default function NothingToFollow() {
  return (
    <NotFoundSource kick="Follow" title="Nothing to follow">
      Follow links name a trader (/follow/trader/ and a 0x address of 40 hex characters) or a thesis the ThemeRegistry holds
      (/follow/thesis/1). Pick one from Discover.
    </NotFoundSource>
  );
}
