import type { Metadata } from "next";
import { NotFoundSource } from "@/components/app/NotFoundSource";
import { PlainShell } from "@/components/app/PlainShell";

export const metadata: Metadata = { title: "Not found", robots: { index: false } };

/** Any URL the site does not have. */
export default function NotFound() {
  return (
    <PlainShell>
      <NotFoundSource kick="404" title="Nothing here">
        This address names no page on Copybook. Traders live at /t/ and a 0x address, theses at /thesis/ and their number, and a copy at /copy/ and its
        transaction.
      </NotFoundSource>
    </PlainShell>
  );
}
