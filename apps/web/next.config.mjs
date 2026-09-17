/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  // React Compiler through Turbopack's native Rust port (#51). No Babel
  // plugin is needed on this path. Components that break the hooks rules
  // are skipped by the compiler, not broken.
  reactCompiler: true,
  experimental: {
    turbopackRustReactCompiler: true,
  },
  images: {
    unoptimized: true,
  },
  async redirects() {
    // Contractor → Service provider rename (2026-09-02): keep old bookmarks working.
    return [
      { source: "/contractors", destination: "/service-providers", permanent: false },
      { source: "/contractor-workspace", destination: "/service-provider-workspace", permanent: false },
      { source: "/contractor-workspace/:path*", destination: "/service-provider-workspace/:path*", permanent: false },
    ]
  },
}

export default nextConfig
