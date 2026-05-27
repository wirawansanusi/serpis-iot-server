/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server (.next/standalone) for a slim Docker runner.
  output: "standalone",
  reactStrictMode: true,
  experimental: {
    // Firmware .bin uploads go through a Server Action; the default 1MB body
    // cap is too small for an ESP32 app image (~1-2MB).
    serverActions: { bodySizeLimit: "16mb" },
  },
};

export default nextConfig;
