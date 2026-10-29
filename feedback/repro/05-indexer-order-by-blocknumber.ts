// 05: on the Hideki indexer, MarginEvent cannot be ordered by blockNumber: the query runs ~10 s and fails with
// "database query error". The same queries ordered by timestamp return in about a second.
// Read-only. Run: node 05-indexer-order-by-blocknumber.ts
import { gql, heading, INDEXER, rpc } from "./lib.ts";

const head = BigInt((await rpc("eth_blockNumber", [], { quiet: true })).result);
const since = (head - 10_000n).toString(); // ~17 minutes of blocks

const queries = [
  `{ MarginEvent(order_by:{blockNumber:desc}, limit:1){ blockNumber timestamp txHash } }`,
  `{ MarginEvent(order_by:{blockNumber:asc}, limit:1){ blockNumber timestamp txHash } }`,
  `{ MarginEvent(where:{blockNumber:{_gt:"${since}"}}, order_by:{blockNumber:desc}, limit:1){ blockNumber timestamp txHash } }`,
  `{ MarginEvent(where:{blockNumber:{_gt:"${since}"}}, order_by:{timestamp:desc}, limit:1){ blockNumber timestamp txHash } }`,
  `{ MarginEvent(order_by:{timestamp:desc}, limit:1){ blockNumber timestamp txHash } }`,
  `{ PerpPositionChange(order_by:{blockNumber:desc}, limit:1){ blockNumber timestamp txHash } }`,
  `{ PerpPositionChange(order_by:{timestamp:desc}, limit:1){ blockNumber timestamp txHash } }`,
];

heading(`${INDEXER}, chain head ${head}`);
for (const query of queries) {
  const at = new Date().toISOString();
  const { body, ms } = await gql(query);
  const result = body.errors ? `errors: ${JSON.stringify(body.errors)}` : `data: ${JSON.stringify(body.data)}`;
  console.log(`${query}\n  ${at}  ${ms} ms  ${result.length > 170 ? `${result.slice(0, 170)}…` : result}\n`);
}
