// Reads the history log to the end, then ranks traders, so the first visitors after a deploy hit warm caches.
// usage: node scripts/warm.mjs https://<deployment>    (npm run warm -- https://<deployment>)
const base = (process.argv[2] ?? process.env.WARM_URL ?? "").replace(/\/$/, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const t0 = Date.now();
  const res = await fetch(base + path, { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, ms: Date.now() - t0 };
}

async function main() {
  if (!/^https?:\/\//.test(base)) {
    console.error("usage: node scripts/warm.mjs <base url>");
    return 2;
  }
  // each request carries its own query, so no edge copy answers it: it has to run the scan
  for (let i = 1; ; i++) {
    const { status, body, ms } = await get(`/api/history?limit=1&warm=${Date.now()}`);
    const missing = Array.isArray(body.missing) ? body.missing.length : "?";
    console.log(`history #${i}: HTTP ${status} in ${ms} ms · complete=${body.complete} · ranges still unread: ${missing}`);
    if (status === 200 && body.complete === true) break;
    if (i >= 20) {
      console.error("the history log did not complete after 20 reads");
      return 1;
    }
    await sleep(5_000);
  }
  const t = await get("/api/traders");
  console.log(`traders: HTTP ${t.status} in ${t.ms} ms · ${t.body.traders?.length ?? 0} ranked · copy-wallet list ${t.body.followerExclusion ?? "?"}`);
  return t.status === 200 ? 0 : 1;
}

// set the code and let open sockets close on their own (exiting under them trips libuv on Windows)
process.exitCode = await main();
