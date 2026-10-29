import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // the npm workspace root: the app imports packages/* and deployments/*.json from there
  outputFileTracingRoot: fileURLToPath(new URL("..", import.meta.url)),
  transpilePackages: ["@copybook/sdk", "@copybook/stats"],
  // the share cards read their fonts from disk at request time
  outputFileTracingIncludes: { "/og/**": ["./assets/og/**"] },
};
export default nextConfig;
