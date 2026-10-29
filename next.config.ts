import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Overridable so the end-to-end test builds into its own directory.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
