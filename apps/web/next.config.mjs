// Who may put the app in a frame (#321). Nobody, on every page: a signed-in
// office page in another site's iframe is a clickjacking target. The one
// surface meant to be framed is the public Collection Days widget a
// municipality embeds on its own site (#293 M2b), its search and an address's
// days. `frame-ancestors` is the rule browsers read; `X-Frame-Options` says
// the same to older ones. A later rule cannot take a header away, only
// override it, so the refusal's source leaves the widget's two paths out and
// the widget's own rule names them. lib/__tests__/frame-headers.test.ts runs
// these through Next's own matcher, and e2e/frame-headers.spec.ts asks a
// running server.
const EMBED = "p/[^/]+/calendar/embed(?:/[^/]+)?/?"

/** The headers every page but the widget answers, and the widget's. */
export const FRAME_HEADERS = {
  refused: [
    { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
    { key: "X-Frame-Options", value: "DENY" },
  ],
  embeddable: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }],
}

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
  async headers() {
    return [
      { source: `/:path((?!${EMBED}$).*)`, headers: FRAME_HEADERS.refused },
      { source: "/p/:slug/calendar/embed", headers: FRAME_HEADERS.embeddable },
      { source: "/p/:slug/calendar/embed/:address", headers: FRAME_HEADERS.embeddable },
    ]
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
    // variables and gets the same one door. WASTE_API_ORIGIN stays when the
    // rewrite goes: the public pages (lib/public/door.ts, ADR-0010) read the
    // public door from the server at request time through it.
    const origin = process.env.WASTE_API_ORIGIN?.replace(/\/+$/, "")
    if (!origin) return []
    return [{ source: "/waste-api/:path*", destination: `${origin}/:path*` }]
  },
}

export default nextConfig
