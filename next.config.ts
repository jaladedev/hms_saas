import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Overridable so the end-to-end test builds into its own directory.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
  poweredByHeader: false,
  // Room photos are uploaded through a server action; the default 1 MB limit is below the 2 MB photo limit.
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
  async headers() {
    return [
      {
        // The service worker may control /app only, and the browser must always re-check it so a fix reaches every laptop.
        source: "/sw.js",
        headers: [
          { key: "Service-Worker-Allowed", value: "/app/" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "text/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
