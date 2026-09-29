import { expect, test as setup } from "@playwright/test"

import { ADMIN_STORAGE_STATE } from "../playwright.api.config"
import { E2E } from "./env"
import { signIn } from "./fixtures"

// Signs the administrator in once, through the real form, and saves the
// browser's storage for every other project. What is captured is the access
// token in localStorage (lib/api/session-storage.ts); the refresh token lives
// in sessionStorage and is not, so the saved session has the token's hour and
// no more — far longer than a run. The login form itself is exercised by
// login.spec.ts, on a context of its own.
setup("the administrator signs in", async ({ page }) => {
  await signIn(page, E2E.loginEmail, E2E.loginPassword)
  await expect(page).toHaveURL(/\/operate/)
  await page.context().storageState({ path: ADMIN_STORAGE_STATE })
})
