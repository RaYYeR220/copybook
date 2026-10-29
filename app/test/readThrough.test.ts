import { describe, expect, it } from "vitest";
import { readThrough, type LoaderCache } from "@/lib/readThrough";

/** A Next-like cache: a loader that throws keeps nothing, and a cache used inside another's loader skips its store. */
function nextLike() {
  const store = new Map<string, unknown>();
  let depth = 0;
  const reads: string[] = [];
  const cache =
    <T>(key: string): LoaderCache<T> =>
    async (loader) => {
      const nested = depth > 0;
      if (!nested && store.has(key)) {
        reads.push(`hit ${key}`);
        return store.get(key) as T;
      }
      reads.push(`${nested ? "skipped" : "miss"} ${key}`);
      depth++;
      try {
        const v = await loader();
        if (!nested) store.set(key, v);
        return v;
      } finally {
        depth--;
      }
    };
  return { store, reads, cache };
}

describe("readThrough", () => {
  it("returns a stored value without computing", async () => {
    const c = nextLike();
    c.store.set("a", 7);
    let ran = 0;
    expect(await readThrough(c.cache<number>("a"), async () => ++ran)).toBe(7);
    expect(ran).toBe(0);
  });

  it("computes a miss outside the loader, so the pieces it reads stay cached, and stores the result", async () => {
    const c = nextLike();
    c.store.set("piece", 2);
    const whole = await readThrough(c.cache<number>("whole"), async () => (await readThrough(c.cache<number>("piece"), async () => 99)) * 10);
    expect(whole).toBe(20);
    expect(c.reads).toEqual(["miss whole", "hit piece", "miss whole"]);
    expect(c.store.get("whole")).toBe(20);
    expect(await readThrough(c.cache<number>("whole"), async () => -1)).toBe(20);
  });

  it("keeps nothing when the computation fails", async () => {
    const c = nextLike();
    await expect(readThrough(c.cache<number>("x"), async () => Promise.reject(new Error("rpc down")))).rejects.toThrow("rpc down");
    expect(c.store.has("x")).toBe(false);
  });

  it("passes on an error from the cache itself", async () => {
    const broken: LoaderCache<number> = async () => {
      throw new Error("cache unavailable");
    };
    await expect(readThrough(broken, async () => 1)).rejects.toThrow("cache unavailable");
  });
});
