/** Rejects a cache's loader on a lookup: nothing is computed and, since the loader failed, nothing is kept. */
const LOOKUP = Symbol("cache lookup");

/**
 * A cache keyed by its caller, whose loader runs on a miss and whose result is kept (Next's `unstable_cache` around
 * one key). The loader must be the only thing that differs between calls, so the lookup and the store share a key.
 */
export type LoaderCache<T> = (loader: () => Promise<T>) => Promise<T>;

/**
 * Reads `cache` first; on a miss runs `compute` in the caller's own async context, then stores its result.
 *
 * Next skips the data cache for an `unstable_cache` called inside another one's loader. A loader that itself reads
 * cached pieces (a checkpoint built from the checkpoint before it and its segments) would therefore rescan every piece
 * from the chain on a miss; computing outside the loader keeps those reads cached.
 */
export async function readThrough<T>(cache: LoaderCache<T>, compute: () => Promise<T>): Promise<T> {
  try {
    return await cache(() => Promise.reject(LOOKUP));
  } catch (e) {
    if (e !== LOOKUP) throw e;
  }
  const value = await compute();
  return cache(async () => value);
}
