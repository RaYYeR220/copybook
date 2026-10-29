/** The environment variables the site's origin is read from (Vercel sets the VERCEL_* ones). */
export interface SiteEnv {
  NEXT_PUBLIC_SITE_URL?: string;
  VERCEL_ENV?: string;
  VERCEL_URL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
}

/**
 * Absolute base for metadata URLs (share cards, canonical links): NEXT_PUBLIC_SITE_URL when set; on a Vercel preview
 * the preview's own URL, so its cards come from the code it runs; otherwise the production URL; locally localhost.
 */
export function siteUrl(env: SiteEnv): string {
  if (env.NEXT_PUBLIC_SITE_URL) return env.NEXT_PUBLIC_SITE_URL;
  const host = env.VERCEL_ENV === "preview" ? env.VERCEL_URL : env.VERCEL_PROJECT_PRODUCTION_URL;
  return host ? `https://${host}` : "http://localhost:3000";
}

/** The site's base on the server, from this deploy's environment (each variable read by name, so Next can inline it). */
export const currentSiteUrl = () =>
  siteUrl({
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  });
