import { NotFoundSource } from "@/components/app/NotFoundSource";
import { copybook } from "@/lib/server/chain";

/** A thesis id the ThemeRegistry does not hold (or that is not an id at all): a 404 that says how many there are. */
export default async function NoThesis() {
  const count = await copybook.themeCount().catch(() => null);
  return (
    <NotFoundSource kick="Thesis" title="No such thesis">
      Theses are numbered from 1 in the order they were published
      {count === null ? "" : `, and the ThemeRegistry holds ${count} thes${count === 1n ? "is" : "es"}`}. Pick one from Discover.
    </NotFoundSource>
  );
}
