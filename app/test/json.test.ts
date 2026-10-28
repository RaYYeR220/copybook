import { describe, expect, it } from "vitest";
import { fromJsonSafe, toJsonSafe } from "@/lib/json";

describe("JSON-safe bigint encoding", () => {
  it("round-trips bigints, including negative and huge ones", () => {
    const v = { a: 1n, b: -50000n, c: 2n ** 200n, d: [3n, { e: 0n }], s: "123", n: 7, z: null };
    const wire = JSON.stringify(toJsonSafe(v));
    expect(wire).not.toMatch(/"-?\d+n"/); // no lossy "123n" strings
    expect(wire).toContain(`{"$bigint":"${2n ** 200n}"}`);
    expect(fromJsonSafe(JSON.parse(wire))).toEqual(v);
  });

  it("keeps plain strings that look like numbers as strings", () => {
    const v = { name: "100", tag: "123n", hex: "0x10" };
    expect(fromJsonSafe(JSON.parse(JSON.stringify(toJsonSafe(v))))).toEqual(v);
  });

  it("drops undefined like JSON does and keeps booleans", () => {
    const v = { a: undefined, b: true };
    expect(JSON.parse(JSON.stringify(toJsonSafe(v)))).toEqual({ b: true });
  });
});
