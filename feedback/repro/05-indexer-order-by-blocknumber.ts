// 05: on the Hideki indexer, the newest MarginEvent / PerpPositionChange rows by blockNumber cannot be read:
// the query runs ~10 s and fails with "database query error". The same query ordered by timestamp is sub-second.
// Read-only. Run: node 05-indexer-order-by-blocknumber.ts
import { gql, heading, INDEXER } from "./lib.ts";

console.log(`indexer: ${INDEXER}`);
const rows: { query: string; ms: number; result: string }[] = [];
for (const table of ["MarginEvent", "PerpPositionChange"]) {
  for (const field of ["timestamp", "blockNumber"]) {
    for (const extra of ["", `where:{kind:{_eq:"${table === "MarginEvent" ? "Credited" : "OPEN"}"}}, `]) {
      const query = `{ ${table}(${extra}order_by:{${field}:desc}, limit:1){ blockNumber timestamp txHash } }`;
      const { body, ms } = await gql(query);
      const result = body.errors ? `errors: ${JSON.stringify(body.errors)}` : `data: ${JSON.stringify(body.data)}`;
      rows.push({ query, ms, result: result.length > 160 ? `${result.slice(0, 160)}…` : result });
    }
  }
}
heading("results");
for (const r of rows) console.log(`${r.query}\n  ${r.ms} ms  ${r.result}\n`);
