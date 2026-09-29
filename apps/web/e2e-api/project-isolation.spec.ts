import { accessTokenOf, apiAs, expect, freshContext, problemOf, signIn, test } from "./fixtures"
import { E2E } from "./env"
import { ensureTester, listAll, TESTER_PROJECT } from "./tester"

// Scenario 3: project isolation through the Invitation flow. The
// administrator invites the tester with one Project; the tester signs in
// through the real form — the access token hook binds the Login to the
// invited account on that first sign-in — and then reaches only that
// Project's records: `/me` names the one project, a project-scoped list
// holds that project's rows alone, and another project's single row is the
// family's 404, not a 403 (auth/projects.ts: a row outside the caller's
// projects does not exist for them).
type PlanningArea = { id: string; projectId: string; name: string }
type Me = { user: { email: string }; role: { name: string }; projects: { id: string; name: string }[] }

test("an invited tester with one Project sees that Project's records and nothing else", async ({ api, browser }) => {
  const { project } = await ensureTester(api, E2E.testerEmail)
  const everyArea = await listAll<PlanningArea>(api, "/planning-areas")
  const elsewhere = everyArea.find((area) => area.projectId !== project.id)
  if (elsewhere === undefined) throw new Error("the seed holds no planning area outside Copenhagen Central to read as the tester")

  const context = await freshContext(browser)
  try {
    const page = await context.newPage()
    await signIn(page, E2E.testerEmail, E2E.loginPassword)
    await expect(page).toHaveURL(/\/operate/)
    const token = await accessTokenOf(context)
    expect(token).not.toBeNull()
    const tester = await apiAs(token as string)
    try {
      const me = await tester.get("/me")
      expect(me.status()).toBe(200)
      const body = (await me.json()) as Me
      expect(body.user.email).toBe(E2E.testerEmail.toLowerCase())
      expect(body.projects.map((candidate) => candidate.name)).toEqual([TESTER_PROJECT])

      const areas = await listAll<PlanningArea>(tester, "/planning-areas")
      expect(areas.length).toBeGreaterThan(0)
      expect(areas.every((area) => area.projectId === project.id)).toBe(true)
      expect(areas.length).toBe(everyArea.filter((area) => area.projectId === project.id).length)

      const other = await tester.get(`/planning-areas/${elsewhere.id}`)
      expect(other.status()).toBe(404)
      expect(await problemOf(other)).toMatchObject({ status: 404 })
    } finally {
      await tester.dispose()
    }
  } finally {
    await context.close()
  }
})
