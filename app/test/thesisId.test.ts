import { describe, expect, it } from "vitest";
import { parseThesisId } from "@/lib/thesisId";

describe("parseThesisId", () => {
  it("takes one spelling per thesis: no zero, no leading zeros, no exponents, at most nine digits", () => {
    expect(parseThesisId("1")).toBe(1n);
    expect(parseThesisId("123456789")).toBe(123456789n);
    for (const bad of ["0", "01", "001", "1e3", "-1", "", " 1", "1234567890", "abc"]) expect(parseThesisId(bad)).toBeNull();
  });
});
