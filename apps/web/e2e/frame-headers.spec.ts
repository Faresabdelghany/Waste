import { expect, test } from "@playwright/test"

// The frame headers (#321) as a running server answers them: a page of the
// office refuses to be framed, and the public Collection Days widget may be
// framed by any site (#293 M2b). lib/__tests__/frame-headers.test.ts holds
// every path through Next's matcher; this holds what the server sends.

test("a page of the app refuses to be framed, and the public widget may be framed by anyone", async ({ request }) => {
  for (const path of ["/login", "/operate"]) {
    const response = await request.get(path)
    expect(response.headers()["content-security-policy"], path).toBe("frame-ancestors 'none'")
    expect(response.headers()["x-frame-options"], path).toBe("DENY")
  }
  for (const path of ["/p/e2e-frame/calendar/embed", "/p/e2e-frame/calendar/embed/01a0d2a4-a280-700c-8000-00000000000b"]) {
    const response = await request.get(path)
    expect(response.headers()["content-security-policy"], path).toBe("frame-ancestors *")
    expect(response.headers()["x-frame-options"], path).toBeUndefined()
  }
})
