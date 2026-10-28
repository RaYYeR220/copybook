export type Address = `0x${string}`;

export interface IndexerOptions {
  /** Hasura GraphQL endpoint of the dreamDEX indexer. */
  url?: string;
  /** Injectable fetch (tests, custom agents). */
  fetch?: typeof fetch;
  /** Rows per request. */
  pageSize?: number;
  /** Hard cap on rows pulled per trader per table; past it the result is flagged truncated. */
  maxRows?: number;
  /** Pause between consecutive requests, in ms. */
  delayMs?: number;
  /** Retries on transient indexer errors. */
  retries?: number;
}

export const DEFAULT_INDEXER_URL = "https://hideki-dev.smk.somnia.host/v1/graphql";

export interface PositionChangeRow {
  id: string;
  pool: string;
  kind: string;
  timestamp: string;
  blockNumber: string;
  logIndex: number;
  txHash: string;
  sizeBefore: string;
  sizeAfter: string;
  entryPriceBefore: string | null;
  entryPriceAfter: string | null;
  realizedPnl: string;
}

export interface LiquidationRow {
  kind: string;
  timestamp: string;
  txHash: string;
  pool: string | null;
}

export interface LeverageRow {
  pool: string;
  leverageX: number;
}

export interface MarketRow {
  poolAddress: string;
  baseSymbol: string;
  baseDecimals: number;
  initialMarginBps: number;
}

export interface Paged<T> {
  rows: T[];
  truncated: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CHANGES = `query Changes($account:String!,$since:numeric!,$limit:Int!,$offset:Int!){
  PerpPositionChange(where:{account:{_eq:$account},timestamp:{_gte:$since}},order_by:[{timestamp:desc},{id:desc}],limit:$limit,offset:$offset){
    id pool kind timestamp blockNumber logIndex txHash sizeBefore sizeAfter entryPriceBefore entryPriceAfter realizedPnl
  }}`;

const LIQUIDATIONS = `query Liquidations($account:String!,$since:numeric!,$limit:Int!,$offset:Int!){
  LiquidationEvent(where:{account:{_eq:$account},timestamp:{_gte:$since},kind:{_in:["AccountLiquidated","PositionLiquidated"]}},order_by:[{timestamp:desc},{id:desc}],limit:$limit,offset:$offset){
    kind timestamp txHash pool
  }}`;

const LAST_ACTIVE = `query LastActive($account:String!){
  PerpPosition(where:{account:{_eq:$account}},order_by:[{updatedAt:desc}],limit:1){ updatedAt }}`;

const LEVERAGE = `query Leverage($account:String!){
  PerpLeverageSetting(where:{account:{_eq:$account}}){ pool leverageX }}`;

const MARKETS = `query Markets{
  Market(where:{marketType:{_eq:PERP}}){ poolAddress baseSymbol baseDecimals initialMarginBps }}`;

const CANDIDATES = `query Candidates($since:numeric!,$limit:Int!){
  PerpPositionChange(where:{timestamp:{_gte:$since}},order_by:[{realizedPnl:desc}],limit:$limit){ account }}`;

export class Indexer {
  readonly url: string;
  readonly pageSize: number;
  readonly maxRows: number;
  private readonly doFetch: typeof fetch;
  private readonly delayMs: number;
  private readonly retries: number;
  private first = true;
  private marketsCache?: Promise<MarketRow[]>;

  constructor(opts: IndexerOptions = {}) {
    this.url = opts.url ?? DEFAULT_INDEXER_URL;
    this.doFetch = opts.fetch ?? fetch;
    this.pageSize = opts.pageSize ?? 500;
    this.maxRows = opts.maxRows ?? 5000;
    this.delayMs = opts.delayMs ?? 100;
    this.retries = opts.retries ?? 2;
  }

  /** One GraphQL request, sequential by construction, with retry on transient failures. */
  async query<T>(operationName: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (!this.first && this.delayMs > 0) await sleep(this.delayMs);
      this.first = false;
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
      try {
        const res = await this.doFetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operationName, query, variables }),
        });
        if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
        const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
        if (body.errors?.length) throw new Error(`indexer error: ${body.errors[0].message}`);
        if (!body.data) throw new Error("indexer returned no data");
        return body.data;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async page<T>(
    operationName: string,
    query: string,
    table: string,
    vars: Record<string, unknown>,
  ): Promise<Paged<T>> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += this.pageSize) {
      const limit = Math.min(this.pageSize, this.maxRows - rows.length);
      const data = await this.query<Record<string, T[]>>(operationName, query, { ...vars, limit, offset });
      const got = data[table];
      rows.push(...got);
      if (got.length < limit) return { rows, truncated: false };
      if (rows.length >= this.maxRows) return { rows, truncated: true };
    }
  }

  positionChanges(account: Address, sinceTs: number) {
    return this.page<PositionChangeRow>("Changes", CHANGES, "PerpPositionChange", {
      account: account.toLowerCase(),
      since: String(sinceTs),
    });
  }

  liquidations(account: Address, sinceTs: number) {
    return this.page<LiquidationRow>("Liquidations", LIQUIDATIONS, "LiquidationEvent", {
      account: account.toLowerCase(),
      since: String(sinceTs),
    });
  }

  async lastActiveTs(account: Address): Promise<number | null> {
    const d = await this.query<{ PerpPosition: { updatedAt: string }[] }>("LastActive", LAST_ACTIVE, {
      account: account.toLowerCase(),
    });
    const t = d.PerpPosition[0]?.updatedAt;
    return t === undefined ? null : Number(t);
  }

  async leverage(account: Address): Promise<LeverageRow[]> {
    const d = await this.query<{ PerpLeverageSetting: LeverageRow[] }>("Leverage", LEVERAGE, {
      account: account.toLowerCase(),
    });
    return d.PerpLeverageSetting;
  }

  /** Perp market metadata; fetched once per client. */
  markets(): Promise<MarketRow[]> {
    this.marketsCache ??= this.query<{ Market: MarketRow[] }>("Markets", MARKETS).then((d) => d.Market);
    this.marketsCache.catch(() => (this.marketsCache = undefined));
    return this.marketsCache;
  }

  /** Accounts behind the largest single realized gains in the window (deduplicated, best first). `rowLimit` caps the rows read. */
  async candidateAccounts(sinceTs: number, rowLimit: number): Promise<Address[]> {
    const d = await this.query<{ PerpPositionChange: { account: string }[] }>("Candidates", CANDIDATES, {
      since: String(sinceTs),
      limit: rowLimit,
    });
    const seen = new Set<string>();
    const out: Address[] = [];
    for (const r of d.PerpPositionChange) {
      const a = r.account.toLowerCase();
      if (!seen.has(a)) {
        seen.add(a);
        out.push(a as Address);
      }
    }
    return out;
  }
}
