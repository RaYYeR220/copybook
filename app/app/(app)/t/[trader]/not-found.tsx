import { NotFoundSource } from "@/components/app/NotFoundSource";

/** A trader URL that is not a wallet address: a 404 that says what the page expects. */
export default function NotAnAddress() {
  return (
    <NotFoundSource kick="Trader" title="Not an address">
      Trader pages live at /t/ followed by a 0x address of 40 hex characters. Pick a trader from Discover.
    </NotFoundSource>
  );
}
