/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server (.next/standalone) for a slim Docker runner.
  output: "standalone",
  reactStrictMode: true,
};

export default nextConfig;
