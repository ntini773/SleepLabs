import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // Keep the dev server's manifests separate from production build output.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  images: { unoptimized: true },
};

export default nextConfig;
