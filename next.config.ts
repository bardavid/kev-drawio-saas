import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev server is opened at 127.0.0.1 while Next's default allowed host is localhost.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
