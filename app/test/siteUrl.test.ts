import { describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/siteUrl";

describe("siteUrl", () => {
  it("is the production alias on a production deploy", () => {
    expect(
      siteUrl({ VERCEL_ENV: "production", VERCEL_URL: "copybook-abc123-team.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "copybook-eosin.vercel.app" }),
    ).toBe("https://copybook-eosin.vercel.app");
  });

  it("is the preview's own URL on a preview", () => {
    expect(
      siteUrl({ VERCEL_ENV: "preview", VERCEL_URL: "copybook-abc123-team.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "copybook-eosin.vercel.app" }),
    ).toBe("https://copybook-abc123-team.vercel.app");
  });

  it("takes NEXT_PUBLIC_SITE_URL over anything Vercel sets", () => {
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: "https://copybook.example", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "copybook-eosin.vercel.app" })).toBe(
      "https://copybook.example",
    );
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: "https://copybook.example", VERCEL_ENV: "preview", VERCEL_URL: "x.vercel.app" })).toBe("https://copybook.example");
  });

  it("is localhost outside Vercel", () => {
    expect(siteUrl({})).toBe("http://localhost:3000");
  });
});
