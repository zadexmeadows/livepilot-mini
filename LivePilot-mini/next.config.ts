import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright", "@prisma/client"],
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
};

export default nextConfig;
