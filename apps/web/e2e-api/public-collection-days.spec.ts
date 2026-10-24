import { E2E } from "./env"
import { expect, freshContext, test } from "./fixtures"

// The public Collection Days end to end (Issue #293, M2b, ADR-0010). The
// administrator publishes the seeded Copenhagen Central under an address of
// the run's own through the API. A visitor with no session then finds
// Strandboulevarden 52, whose Residual bin the seeded RS-Østerbro · Organic B
// collects on Tuesdays and Thursdays every other week, reads its days by
// month, reads the feed the page links to, and opens the widget a
// municipality embeds. The page is held to the door's own answer for the
// address, date for date, never to a weekday pattern: the e2e database is
// shared, and another spec generating RS-Central · Week A (whose Residual
// rule may match the bin) or moving one of its routes onto today (the
// dispatched-route helper) changes the days, rightly. The door's rules are
// the API's tests'. Unpublished again, the address is not found and nor is its
// feed; the project goes back unpublished whatever happens.

type Project = { id: string; name: string }
type Page<T> = { items: T[] }

const ADDRESS = "Strandboulevarden 52, 2100 København Ø"

test("a visitor with no account finds an address of a published project, reads its collection days, its feed and its widget, and unpublished it is not found", async ({ api, browser }) => {
  const listed = await api.get("/projects", { params: { limit: 200 } })
  expect(listed.status()).toBe(200)
  const project = ((await listed.json()) as Page<Project>).items.find((candidate) => candidate.name === "Copenhagen Central")
  expect(project, "the seed holds Copenhagen Central").toBeDefined()
  const projectId = project!.id
  const slug = `e2e-calendar-${Date.now().toString(36)}`
  const published = await api.patch(`/projects/${projectId}`, { data: { publicSlug: slug } })
  expect(published.status()).toBe(200)

  const visitor = await freshContext(browser)
  try {
    const reader = await visitor.newPage()
    await reader.goto(`/p/${slug}/calendar`)
    await expect(reader.getByRole("heading", { level: 1, name: "Collection days" })).toBeVisible()
    await expect(reader.getByText("Copenhagen Central")).toBeVisible()
    await expect(reader.getByText("Copenhagen Central")).toHaveAttribute("lang", "da")

    await reader.goto(`/p/${slug}/calendar?q=St`)
    await expect(reader.getByText("Type at least 3 letters of your address.")).toBeVisible()

    const search = reader.getByRole("searchbox", { name: "Your address" })
    await search.fill("Strandboulevarden 52")
    await search.press("Enter")
    await expect(reader).toHaveURL(new RegExp(`/p/${slug}/calendar\\?q=Strandboulevarden\\+52$`))
    await reader.getByRole("link", { name: ADDRESS }).click()

    await expect(reader.getByRole("heading", { level: 1, name: ADDRESS })).toBeVisible()
    await expect(reader.getByText("The next 8 weeks")).toBeVisible()
    const addressId = new URL(reader.url()).pathname.split("/").at(-1)
    const answered = await visitor.request.get(`${E2E.apiUrl}/public/${slug}/addresses/${addressId}/collection-days`)
    expect(answered.status()).toBe(200)
    const doorDates = [...new Set(((await answered.json()) as { days: { date: string }[] }).days.map((day) => day.date))]
    const dates = reader.locator("li time")
    await expect(dates.first()).toBeVisible()
    expect(await dates.evaluateAll((elements) => elements.map((element) => element.getAttribute("datetime"))), "the page shows the door's dates, each once, in order").toEqual(doorDates)
    expect((await dates.allTextContents()).some((label) => /^(Tuesday|Thursday) /.test(label)), "Organic B's Tuesdays and Thursdays among them").toBe(true)
    await expect(reader.getByRole("listitem").filter({ hasText: "Residual" }).first()).toBeVisible()

    await reader.getByRole("link", { name: "26 weeks" }).click()
    await expect(reader.getByText("The next 26 weeks")).toBeVisible()
    await expect(reader).toHaveURL(/\?weeks=26$/)

    const feedPath = await reader.getByRole("link", { name: "Download (.ics)" }).getAttribute("href")
    expect(feedPath).toMatch(new RegExp(`^/p/${slug}/calendar/[0-9a-f-]{36}/calendar\\.ics$`))
    await expect(reader.getByRole("link", { name: "Subscribe in your calendar" })).toHaveAttribute("href", new RegExp(`^webcal://[^/]+${feedPath!.replaceAll(".", "\\.")}$`))
    await expect(reader.getByLabel("Calendar address")).toHaveValue(new RegExp(`^https?://[^/]+${feedPath!.replaceAll(".", "\\.")}$`))
    const feed = await visitor.request.get(feedPath!)
    expect(feed.status()).toBe(200)
    expect(feed.headers()["content-type"]).toBe("text/calendar; charset=utf-8")
    const ics = await feed.text()
    expect(ics).toContain("BEGIN:VCALENDAR")
    expect(ics).toContain("SUMMARY:Residual")
    expect(ics).toContain(`@${slug}`)

    const addressPath = feedPath!.replace(/\/calendar\.ics$/, "")
    await reader.goto(addressPath.replace("/calendar/", "/calendar/embed/"))
    await expect(reader.getByRole("heading", { level: 1, name: ADDRESS })).toBeVisible()
    const widgetDates = await reader.locator("li time").evaluateAll((elements) => elements.map((element) => element.getAttribute("datetime")))
    expect(widgetDates.length).toBeGreaterThan(0)
    expect(widgetDates, "the widget's next dates are the door's first ones").toEqual(doorDates.slice(0, widgetDates.length))
    await expect(reader.getByRole("link", { name: "Full calendar" })).toHaveAttribute("href", addressPath)
    await expect(reader.getByRole("link", { name: "Subscribe in your calendar" })).toHaveCount(0)

    const unpublished = await api.patch(`/projects/${projectId}`, { data: { publicSlug: null } })
    expect(unpublished.status()).toBe(200)
    await reader.goto(addressPath)
    await expect(reader.getByText("This page could not be found.")).toBeVisible()
    expect((await visitor.request.get(feedPath!)).status()).toBe(404)
  } finally {
    await visitor.close()
    await api.patch(`/projects/${projectId}`, { data: { publicSlug: null } })
  }
})
