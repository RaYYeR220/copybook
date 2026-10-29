import { NotFoundSource } from "@/components/app/NotFoundSource";

/** A transaction with no Copybook copy in it (or none at that log index): nothing to show, and no card. */
export default function NoCopy() {
  return (
    <NotFoundSource kick="A copy" title="No copy in this transaction">
      This transaction holds no Copied event from the Copybook hub, or none at that log index, so there is nothing to share. Copies are listed on Discover and on each trader and thesis
      page; a transaction that has not landed yet shows here once it does.
    </NotFoundSource>
  );
}
