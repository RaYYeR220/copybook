import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import type { RawLog } from "@copybook/sdk";
import { LEADER, guardReview, sameBlockOpen, thesisRebalance } from "@/content/proof";
import { loadCopy, type CopyDeps, type CopyReceipt } from "@/lib/copy";
import { fromJsonSafe } from "@/lib/json";
import { latestCopy } from "@/lib/me/activity";
import type { LoggedEvent } from "@/lib/events";
import {
  LINK_WEIGHT,
  POST_LIMIT,
  copyShareOf,
  copyShareText,
  pageUrl,
  postLength,
  postableName,
  thesisShareText,
  traderShareText,
  weightedLength,
  xIntentUrl,
} from "@/lib/share";
import raw from "./fixtures/copies.json";

// the connected wallet, as wagmi would report it
const account: { address?: Address } = {};
vi.mock("wagmi", () => ({ useAccount: () => account }));
const { CopyStatus, OwnerShareOnX, ShareOnX } = await import("@/components/share/ShareOnX");

interface Entry {
  hash: Hex;
  receipt: CopyReceipt;
  tx: { from: Address; to: Address | null; input: Hex };
  blockTime: number;
  logs: { query: { block: bigint; address: Address }; result: RawLog[] }[];
}
const fx = fromJsonSafe<{ deployments: { hub: Address; themes: Address; marginBank: Address }; txs: Record<string, Entry> }>(raw);
const entries = Object.values(fx.txs);
const chain: CopyDeps = {
  deployments: { ...fx.deployments, gate: "0xEe5400000000000000000000000000000000020f" },
  receipt: async (h) => entries.find((e) => e.hash.toLowerCase() === h.toLowerCase())?.receipt ?? null,
  transaction: async (h) => entries.find((e) => e.hash.toLowerCase() === h.toLowerCase())!.tx,
  blockTime: async (b) => entries.find((e) => e.receipt.blockNumber === b)!.blockTime,
  logs: async (q) => entries.flatMap((e) => e.logs).find((l) => l.query.block === q.block && l.query.address.toLowerCase() === q.address.toLowerCase())?.result ?? [],
};
const names = { theses: { "1": "BTC vs ETH" }, demoLeader: getAddress(LEADER) };
const SITE = "https://copybook-eosin.vercel.app";
const OTHER = getAddress(guardReview.trader);

/** The intent's query, as X reads it back. */
const intentOf = (href: string) => {
  const u = new URL(href);
  return { origin: u.origin, path: u.pathname, text: u.searchParams.get("text"), url: u.searchParams.get("url") };
};
const fits = (text: string) => expect(postLength(text)).toBeLessThanOrEqual(POST_LIMIT);

describe("what a copy's post says, from the copy's own reads", () => {
  it("a same-block trader copy names the block the page shows", async () => {
    const v = (await loadCopy(sameBlockOpen.copy.hash, undefined, chain))!;
    const mine = copyShareText({ ...copyShareOf(v, names), mine: true });
    expect(mine).toBe(
      "My copy of the demo leader landed in the same block as their trade: block #35,025,602 on Somnia's Tokyo testnet, via Copybook on @DreamDEXSomnia perps.",
    );
    // a visitor who is not the follower does not get to say "my"
    expect(copyShareText({ ...copyShareOf(v, names), mine: false })).toBe(
      "A copy of the demo leader landed in the same block as their trade: block #35,025,602 on Somnia's Tokyo testnet, via Copybook on @DreamDEXSomnia perps.",
    );
    fits(mine);
  });

  it("a trader who is not ours is named by the short address", () => {
    expect(copyShareText({ source: { kind: "Trader", trader: OTHER }, block: 35025602n, sameBlock: true, mine: true })).toBe(
      "My copy of 0xb870…50a8 landed in the same block as their trade: block #35,025,602 on Somnia's Tokyo testnet, via Copybook on @DreamDEXSomnia perps.",
    );
  });

  it("a thesis copy answers a rebalance, not a trade", async () => {
    const v = (await loadCopy(thesisRebalance.copy.hash, undefined, chain))!;
    expect(copyShareText({ ...copyShareOf(v, names), mine: true })).toBe(
      "My copy of the thesis 'BTC vs ETH' landed in the same block as its rebalance: block #35,026,714 on Somnia's Tokyo testnet, via Copybook on @DreamDEXSomnia perps.",
    );
    expect(copyShareText({ ...copyShareOf(v, { ...names, theses: {} }), mine: true })).toBe(
      "My copy of thesis #1 landed in the same block as its rebalance: block #35,026,714 on Somnia's Tokyo testnet, via Copybook on @DreamDEXSomnia perps.",
    );
  });

  it("a copy sent by a call names the call and claims no same block", async () => {
    const v = (await loadCopy(fx.txs.followCopy.hash, undefined, chain))!;
    const text = copyShareText({ ...copyShareOf(v, names), mine: true });
    expect(text).toBe("My copy of the thesis 'BTC vs ETH' came from a follow call to the Copybook hub, in block #35,026,093 on Somnia's Tokyo testnet, on @DreamDEXSomnia perps.");
    expect(text).not.toMatch(/same block/);
  });

  it("without the source or how it was sent, it says only the block", () => {
    expect(copyShareText({ source: null, block: 35025602n, sameBlock: undefined, mine: true })).toBe(
      "My copy is in block #35,025,602 on Somnia's Tokyo testnet, via Copybook on @DreamDEXSomnia perps.",
    );
    expect(copyShareText({ source: null, block: 35025602n, sameBlock: false, mine: false })).toBe(
      "A copy came from a direct call to the Copybook hub, in block #35,025,602 on Somnia's Tokyo testnet, on @DreamDEXSomnia perps.",
    );
  });
});

describe("what a trader's and a thesis's posts say", () => {
  it("a trader page invites followers; the trader's own wallet speaks for itself", () => {
    expect(traderShareText({ trader: OTHER })).toBe("Follow 0xb870…50a8 on Copybook: copies land in their block on @DreamDEXSomnia perps (Somnia testnet).");
    expect(traderShareText({ trader: getAddress(LEADER), demo: true })).toBe(
      "Follow the demo leader 0xA1d0…7b5d on Copybook: copies land in their block on @DreamDEXSomnia perps (Somnia testnet).",
    );
    expect(traderShareText({ trader: OTHER, own: true })).toBe(
      "Follow my trades on Copybook: copies land in the same block as mine on @DreamDEXSomnia perps (Somnia testnet).",
    );
  });

  it("a thesis page counts its legs", () => {
    expect(thesisShareText({ id: 1n, name: "BTC vs ETH", legs: 2 })).toBe(
      "Follow the thesis 'BTC vs ETH' on Copybook: 2 legs, opened in one transaction on @DreamDEXSomnia perps.",
    );
    expect(thesisShareText({ id: 1n, name: "BTC vs ETH", legs: 2, own: true })).toBe(
      "Follow my thesis 'BTC vs ETH' on Copybook: 2 legs, opened in one transaction on @DreamDEXSomnia perps.",
    );
    expect(thesisShareText({ id: 4n, name: "Just BTC", legs: 1 })).toBe("Follow the thesis 'Just BTC' on Copybook: 1 leg, opened in one transaction on @DreamDEXSomnia perps.");
    expect(thesisShareText({ id: 4n, name: "  ", legs: 1 })).toBe("Follow the thesis #4 on Copybook: 1 leg, opened in one transaction on @DreamDEXSomnia perps.");
  });

  it("a name too long for one post is cut, on one line, and the post still fits with its link", () => {
    const long = `Majors\nagainst ${"the long tail of perps ".repeat(20)}`;
    const t = thesisShareText({ id: 9n, name: long, legs: 12 });
    expect(postLength(t)).toBeLessThanOrEqual(POST_LIMIT);
    expect(postLength(t)).toBeGreaterThan(POST_LIMIT - 3);
    expect(t).toMatch(/^Follow the thesis 'Majors against the long tail of perps .*…' on Copybook: 12 legs, opened in one transaction on @DreamDEXSomnia perps\.$/);
    expect(t).not.toMatch(/\n/);
    const c = copyShareText({ source: { kind: "Theme", themeId: 9n, name: "東京".repeat(200) }, block: 35025602n, sameBlock: true, mine: true });
    expect(postLength(c)).toBeLessThanOrEqual(POST_LIMIT);
    expect(c).toMatch(/^My copy of the thesis '東京.*…' landed in the same block as its rebalance: /);
  });

  it("a cut never splits an emoji sequence or a flag", () => {
    // a skin-tone sequence and a flag: two code points each, one grapheme each (ZWJ sequences give way to the id, below)
    const thumb = "👍🏽";
    const t = thesisShareText({ id: 2n, name: `${thumb}🇯🇵`.repeat(40), legs: 2 });
    expect(postLength(t)).toBeLessThanOrEqual(POST_LIMIT);
    const cut = t.match(/^Follow the thesis '(.*)…' on Copybook/u)![1];
    expect(cut.length).toBeGreaterThan(0);
    // what is left is whole thumb-and-flag pairs, or a pair and one more thumb: never a part of either
    expect(cut).toMatch(/^(?:👍🏽🇯🇵)*(?:👍🏽)?$/u);
  });

  it("every post fits with its link at X's 23 characters", () => {
    for (const t of [
      copyShareText({ source: { kind: "Trader", trader: OTHER }, block: 999_999_999n, sameBlock: true, mine: false }),
      copyShareText({ source: { kind: "Theme", themeId: 1n, name: "x".repeat(48) }, block: 999_999_999n, sameBlock: false, call: "catchUp", mine: true }),
      traderShareText({ trader: OTHER, demo: true }),
      thesisShareText({ id: 1n, name: "x".repeat(48), legs: 16 }),
    ])
      fits(t);
  });
});

describe("names X would make live", () => {
  // anyone can register a thesis under any name: nothing in one may become a mention, a tag or a link in the sharer's post
  const live = [
    ["a mention", "Follow @elonmusk"],
    ["a full-width mention", "Follow ＠someone"],
    ["a hashtag", "BTC #toTheMoon"],
    ["a full-width hashtag", "BTC ＃moon"],
    ["a cashtag", "$BTC vs $ETH"],
    ["a link", "see http://scam.example/claim"],
    ["a link without its scheme's name", "ftp://files"],
    ["www", "www.example"],
    ["a bare .com", "claim at copybook-airdrop.com"],
    ["a bare .io", "majors.io basket"],
    ["a bare .xyz", "free.xyz"],
    ["a bare .ai", "best.ai picks"],
    ["a bare upper-case domain", "VISIT EXAMPLE.NET NOW"],
    // characters that hide a token from the checks, or reorder what a reader sees
    ["a zero-width space in a mention", "@\u200bname"],
    ["a zero-width space in a domain", "ex\u200bample.com"],
    ["a zero-width space before the dot", "copybook\u200b.xyz"],
    ["full-width www and dots (NFKC folds them)", "ｗｗｗ．example．com"],
    ["a full-width mention alone (NFKC folds it to @)", "＠name"],
    ["a combining mark before the dot", "copybook\u034f.xyz"],
    ["an enclosing mark", "BTC\u20dd majors"],
    ["a right-to-left override", "majors \u202eUSD"],
    ["a reversed domain behind a right-to-left override", "BTC \u202emoc.elpmaxe"],
    ["a bidi isolate", "\u2066BTC vs ETH\u2069"],
    ["a soft hyphen", "copy\u00adbook"],
    ["a zero-width-joined emoji", "👨\u200d👩\u200d👧 basket"],
  ] as const;

  it.each(live)("%s gives way to the thesis id", (_, name) => {
    expect(postableName(name)).toBeNull();
    expect(thesisShareText({ id: 7n, name, legs: 2 })).toBe("Follow the thesis #7 on Copybook: 2 legs, opened in one transaction on @DreamDEXSomnia perps.");
    expect(copyShareText({ source: { kind: "Theme", themeId: 7n, name }, block: 35025602n, sameBlock: true, mine: true })).toBe(
      "My copy of thesis #7 landed in the same block as its rebalance: block #35,025,602 on Somnia's Tokyo testnet, via Copybook on @DreamDEXSomnia perps.",
    );
  });

  it("plain names, figures with decimals included, are kept as written", () => {
    for (const name of ["BTC vs ETH", "Majors 2.0", "ETH 3.5x long, BTC short", "L1s vs L2s", "東京 basket", "e.g. majors"]) {
      expect(postableName(name)).toBe(name);
      expect(thesisShareText({ id: 7n, name, legs: 2 })).toBe(`Follow the thesis '${name}' on Copybook: 2 legs, opened in one transaction on @DreamDEXSomnia perps.`);
    }
    expect(postableName("  BTC\n vs\tETH ")).toBe("BTC vs ETH");
    expect(postableName("")).toBeNull();
  });

  it("the post carries the normalized name, the one that was checked", () => {
    // a decomposed accent composes away (NFKC), full-width letters and odd spaces fold to plain ones
    expect(postableName("Cafe\u0301 majors")).toBe("Café majors");
    expect(postableName("ＢＴＣ\u3000vs\u00a0ＥＴＨ")).toBe("BTC vs ETH");
    expect(thesisShareText({ id: 7n, name: "ＢＴＣ vs ＥＴＨ", legs: 2 })).toBe("Follow the thesis 'BTC vs ETH' on Copybook: 2 legs, opened in one transaction on @DreamDEXSomnia perps.");
    expect(copyShareText({ source: { kind: "Theme", themeId: 7n, name: "Cafe\u0301 majors" }, block: 1n, sameBlock: true, mine: true })).toBe(
      "My copy of the thesis 'Café majors' landed in the same block as its rebalance: block #1 on Somnia's Tokyo testnet, via Copybook on @DreamDEXSomnia perps.",
    );
    expect(postableName(null)).toBeNull();
  });
});

describe("how X counts a post", () => {
  it("weights as twitter-text does: latin one, CJK and the ellipsis two, the link 23", () => {
    expect(weightedLength("Follow")).toBe(6);
    expect(weightedLength("…")).toBe(2);
    expect(weightedLength("東京")).toBe(4);
    expect(weightedLength("😀")).toBe(2);
    expect(postLength("abc")).toBe(3 + 1 + LINK_WEIGHT);
    expect(postLength("abc", false)).toBe(3);
  });

  it("the intent carries the text and the link, each encoded whole", () => {
    const text = "Follow the thesis 'A & B? #1 = 100%' on Copybook: 2 legs, opened in one transaction on @DreamDEXSomnia perps.";
    const url = pageUrl(SITE, `/copy/${sameBlockOpen.copy.hash}?log=3`);
    const href = xIntentUrl(text, url);
    expect(href.startsWith("https://x.com/intent/post?text=Follow%20the%20thesis%20'A%20%26%20B%3F%20%231%20%3D%20100%25'")).toBe(true);
    expect(href).toContain("%40DreamDEXSomnia");
    expect(href).toContain(`&url=https%3A%2F%2Fcopybook-eosin.vercel.app%2Fcopy%2F${sameBlockOpen.copy.hash}%3Flog%3D3`);
    expect(intentOf(href)).toEqual({ origin: "https://x.com", path: "/intent/post", text, url });
  });

  it("links are absolute, on the site they were rendered for", () => {
    expect(pageUrl(SITE, "/t/0xA1d0cb85c869e534fe1e0c22af3b238301157b5d")).toBe("https://copybook-eosin.vercel.app/t/0xA1d0cb85c869e534fe1e0c22af3b238301157b5d");
    expect(pageUrl("http://localhost:3000", "/thesis/1")).toBe("http://localhost:3000/thesis/1");
  });
});

describe("the share pills", () => {
  beforeEach(() => {
    delete account.address;
  });
  const hrefOf = (html: string) => {
    const m = html.match(/<a [^>]*href="([^"]+)"/);
    return m ? m[1].replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"') : null;
  };

  it("open X's composer in a new tab, without the opener, and copy the link", () => {
    const text = traderShareText({ trader: OTHER });
    const url = pageUrl(SITE, `/t/${OTHER}`);
    const html = renderToStaticMarkup(<ShareOnX text={text} url={url} subject="this trader's page" />);
    expect(hrefOf(html)).toBe(xIntentUrl(text, url));
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('aria-label="Share on X: this trader&#x27;s page (opens in a new tab)"');
    expect(html).toMatch(/<button type="button"[^>]*aria-label="Copy link to this trader&#x27;s page"[^>]*>Copy link<\/button>/);
    expect(html).toContain('role="status"');
  });

  it("say Copied, or when the browser refuses, hold the link in a field to select and copy", () => {
    const url = pageUrl(SITE, "/copy/0xabc?log=1");
    const idle = renderToStaticMarkup(<CopyStatus state="idle" url={url} subject="your latest copy" />);
    expect(idle).toMatch(/^<span [^>]*role="status" aria-live="polite"><\/span>$/);
    expect(renderToStaticMarkup(<CopyStatus state="done" url={url} subject="your latest copy" />)).toContain(">Copied</span>");
    const failed = renderToStaticMarkup(<CopyStatus state="failed" url={url} subject="your latest copy" />);
    expect(failed).toContain(">Not copied: select the link and copy it</span>");
    const input = failed.match(/<input [^>]*\/>/)?.[0] ?? "";
    for (const attr of ['type="text"', 'readOnly=""', `value="${url}"`, 'aria-label="Link to your latest copy"']) expect(input).toContain(attr);
    expect(failed).not.toMatch(/address bar/);
  });

  it("speak in the owner's words only when the connected wallet is the owner", () => {
    const props = { owner: OTHER, text: traderShareText({ trader: OTHER }), ownText: traderShareText({ trader: OTHER, own: true }), url: pageUrl(SITE, `/t/${OTHER}`), subject: "this trader's page" };
    expect(intentOf(hrefOf(renderToStaticMarkup(<OwnerShareOnX {...props} />))!).text).toBe(props.text);
    account.address = getAddress(LEADER);
    expect(intentOf(hrefOf(renderToStaticMarkup(<OwnerShareOnX {...props} />))!).text).toBe(props.text);
    account.address = OTHER.toLowerCase() as Address;
    expect(intentOf(hrefOf(renderToStaticMarkup(<OwnerShareOnX {...props} />))!).text).toBe(props.ownText);
  });
});

describe("the dashboard's latest copy", () => {
  const me = getAddress("0x1111111111111111111111111111111111111111");
  const copied = (block: bigint, logIndex: number, over: Partial<LoggedEvent> = {}) =>
    ({
      name: "Copied",
      follower: me,
      sourceId: "0x01" as Hex,
      pool: "0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0",
      fromSize: 0n,
      toSize: 1n,
      limitPrice: 1n,
      capped: false,
      log: { blockNumber: block, logIndex, transactionHash: `0x${block.toString(16).padStart(64, "0")}` as Hex },
      ...over,
    }) as unknown as LoggedEvent;

  it("is the newest copy into this wallet, linked to its page, with how it was sent", () => {
    const events = [copied(10n, 2, { via: "call" } as Partial<LoggedEvent>), copied(12n, 1, { via: "handler" } as Partial<LoggedEvent>), copied(12n, 4), copied(13n, 0, { follower: OTHER } as Partial<LoggedEvent>)];
    expect(latestCopy(events, me)).toEqual({
      path: `/copy/0x${(12).toString(16).padStart(64, "0")}?log=4`,
      block: 12n,
      pool: getAddress("0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0"),
      sourceId: "0x01",
    });
    expect(latestCopy(events.slice(0, 2), me)?.via).toBe("handler");
    expect(latestCopy([], me)).toBeUndefined();
  });
});
