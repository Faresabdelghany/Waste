/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  // React Compiler through Turbopack's native Rust port (#51). No Babel
  // plugin is needed on this path. Components that break the hooks rules
  // are skipped by the compiler, not broken.
  reactCompiler: true,
  // Cache Components (Partial Prerendering, "use cache", <Activity> route
  // preservation) and Partial Prefetching (#51). Every segment currently
  // exports `instant = false`, so routes may still block on request data
  // exactly as before; converting them to instant shells is follow-up work.
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    turbopackRustReactCompiler: true,
    // Failed navigations, prefetches and Server Actions stay pending and
    // retry when the connection returns instead of throwing (#51).
    useOffline: true,
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
  async rewrites() {
    // The API behind the web's own origin (Issue #81). The browser calls
    // `NEXT_PUBLIC_WASTE_API_URL` (`/waste-api` locally) and Next forwards it
    // to `WASTE_API_ORIGIN` (`http://127.0.0.1:3001`): the API has no CORS
    // yet, and a same-origin path needs none — `Location`, which a browser
    // may read across origins only when CORS exposes it (#74), is readable
    // here as it is. The token still travels in `Authorization`; nothing is
    // a cookie. When the API's CORS lands, the public URL becomes the API's
    // origin and this rewrite goes; until then a deployment sets both
    // variables and gets the same one door.
    const origin = process.env.WASTE_API_ORIGIN?.replace(/\/+$/, "")
    if (!origin) return []
    return [{ source: "/waste-api/:path*", destination: `${origin}/:path*` }]
  },
}

export default nextConfig
