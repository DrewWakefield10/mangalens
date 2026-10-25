import type { NextConfig } from "next";

const isVercel = process.env.VERCEL === "1";
const apiInternalUrl = process.env.API_INTERNAL_URL?.replace(/\/+$/, "");

const cloudMode =
  process.env.MANGALENS_CLOUD === "1" || (isVercel && !apiInternalUrl);
const apiUrl = apiInternalUrl
  ? new URL(apiInternalUrl)
  : cloudMode
    ? undefined
    : new URL("http://127.0.0.1:8000");
if (
  apiUrl &&
  (!["http:", "https:"].includes(apiUrl.protocol) ||
    (isVercel && apiUrl.protocol !== "https:") ||
    apiUrl.pathname !== "/" ||
    apiUrl.search ||
    apiUrl.hash ||
    apiUrl.username ||
    apiUrl.password)
)
  throw new Error(
    "API_INTERNAL_URL must be an HTTP(S) origin without a path or credentials; Vercel requires HTTPS.",
  );

const config: NextConfig = {
  turbopack: { root: process.cwd() },
  output: isVercel || cloudMode ? undefined : "standalone",
  async rewrites() {
    return apiUrl
      ? [
          {
            source: "/api/:path*",
            destination: `${apiUrl.origin}/api/:path*`,
          },
        ]
      : [];
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
