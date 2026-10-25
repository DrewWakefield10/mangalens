import type { NextConfig } from "next";

const isVercel = process.env.VERCEL === "1";
const apiInternalUrl = process.env.API_INTERNAL_URL?.replace(/\/+$/, "");

if (isVercel && !apiInternalUrl) {
  throw new Error(
    "API_INTERNAL_URL must be set to the deployed MangaLens API URL when building for Vercel.",
  );
}

const apiUrl = new URL(apiInternalUrl || "http://127.0.0.1:8000");
if (
  !["http:", "https:"].includes(apiUrl.protocol) ||
  (isVercel && apiUrl.protocol !== "https:") ||
  apiUrl.pathname !== "/" ||
  apiUrl.search ||
  apiUrl.hash ||
  apiUrl.username ||
  apiUrl.password
) {
  throw new Error(
    "API_INTERNAL_URL must be an HTTP(S) origin without a path or credentials; Vercel requires HTTPS.",
  );
}

const config: NextConfig = {
  turbopack: { root: process.cwd() },
  output: isVercel ? undefined : "standalone",
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl.origin}/api/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "CDN-Cache-Control", value: "no-store" },
          { key: "Vercel-CDN-Cache-Control", value: "no-store" },
          { key: "x-vercel-enable-rewrite-caching", value: "0" },
        ],
      },
    ];
  },
};
export default config;
