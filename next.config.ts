import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Overridable so the end-to-end test builds into its own directory.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
  poweredByHeader: false,
  // Room photos are uploaded through a server action; the default 1 MB limit is below the 2 MB photo limit.
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
};

export default nextConfig;
