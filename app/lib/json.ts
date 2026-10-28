/**
 * JSON has no bigint. On the wire a bigint is `{"$bigint":"<decimal>"}`, which no other value in a Copybook payload
 * takes the shape of, so decoding is unambiguous (a string such as "123" stays a string).
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const TAG = "$bigint";

export function toJsonSafe(v: unknown): Json {
  if (typeof v === "bigint") return { [TAG]: v.toString() };
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : toJsonSafe(x)));
  if (v && typeof v === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toJsonSafe(x);
    return out;
  }
  return v as Json;
}

export function fromJsonSafe<T = unknown>(v: unknown): T {
  if (Array.isArray(v)) return v.map((x) => fromJsonSafe(x)) as T;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === TAG && typeof o[TAG] === "string") return BigInt(o[TAG] as string) as T;
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = fromJsonSafe(o[k]);
    return out as T;
  }
  return v as T;
}
