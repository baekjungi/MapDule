# MapDule production update

Status: Validated

## 1. Scope and approval

The user requested allowing AI access without a Microsoft account on 2026-11-05.
Update the existing application only. Preserve the existing design, family chat, Korean UI and server reliability fixes.
Do not create, delete or reconfigure Azure infrastructure or expose application secrets.

## 2. Existing deployment

- Repository: baekjungi/MapDule, branch main.
- Target: existing Azure Static Web App mapdule-baekjungi.
- Resource group: rg-mapdule-prod, region East Asia.
- Site: https://gentle-beach-07f533300.1.azurestaticapps.net
- Deployment identity: existing GitHub Actions app-specific deployment token.
- No local Azure subscription selection or infrastructure provisioning is required.

## 3. Recipe

recipe.type: cicd

Use the existing GitHub Actions workflow:
`.github/workflows/azure-static-web-apps-gentle-beach-07f533300.yml`.
It validates JavaScript, runs tests, builds public assets and uploads dist plus api to the existing Static Web App.
Do not switch to azd, create an environment or generate replacement infrastructure.

## 4. Changes

- Allow anonymous access on AI parse and plan routes and advertise authRequired: false.
- Keep server-side API keys and existing HTML/JSON error handling.
- Apply shared per-IP minute/day limits and per-instance concurrency limits to both AI operations.
- Preserve in-progress family/UI edits made by another agent; deploy only files from this request.

## 5. Validation

- [x] All validation checks pass
  - [x] JavaScript syntax: npm run check
  - [x] Full regression suite: npm test
  - [x] Public asset build: npm run build
  - [x] Whitespace: git diff --check
  - [x] Anonymous Functions status/parse/plan and shared request limit tests
  - [x] Existing pipeline and deployment token configuration
  - [x] Static role verification: guest routes enabled; API secrets remain server-side; no Azure RBAC changes

## 6. Deployment and verification

Commit only the verified guest-access changes, push normally to main and monitor the matching GitHub Actions run.
Verify production assets and endpoints, then exercise actual unauthenticated AI inference in the browser.
Do not claim successful Azure OpenAI inference unless it has actually been exercised.
Rollback, if needed, uses a normal revert commit after identifying the failed deployment; no destructive Git commands.

## 7. Validation Proof

Guest-access validation: 2026-11-05, approximately 21:53 Asia/Seoul.

- `npm run check`, `npm test`, `npm run build`, `git diff --check`: passed.
- All 70 tests in the shared worktree passed, including five new guest/limiter tests
  and concurrent family-workflow tests belonging to another agent.
- Functions tests invoke both operations with no identity/cookie headers and confirm success.
- Status test confirms `authRequired: false`.
- Rate-limit tests verify exactly ten calls per minute, 100 per 24 hours, reset windows,
  shared parse/plan counters, Retry-After, three concurrent operations and release on failure.
- Existing deployment token name and live Static Web App hostname confirmed without reading secrets.
- Static review confirms both AI routes explicitly permit the anonymous role, API keys
  remain on the server and no Azure RBAC or infrastructure changes are included.
- Concurrent integration commit `29cd16eb53f05e940ae591edc57f1706e10aee9c`
  included guest access. Its existing GitHub Actions run `42030923252` succeeded.
- Production verification: unauthenticated status returned HTTP 200 with
  `configured: true` and `authRequired: false`.
- Real unauthenticated parse returned HTTP 200 and the requested meeting on
  2026-11-06, 15:00-16:00; plan returned HTTP 200 with a Korean summary.
- Browser verification displayed the parsed meeting preview and enabled registration
  without requiring a login.

The results below are historical evidence for the preceding deployment.

Validation date: 2026-11-05, approximately 21:42-21:44 Asia/Seoul.

- `npm run check`: passed JavaScript syntax checks.
- `npm test`: 56 tests passed, zero failures, including three new browser-response regressions.
- `npm run build`: passed; output remains the six existing public browser assets.
- `git diff --check`: passed.
- Browser on the local application: HTML 401 displays Korean login guidance and a sign-in link,
  preserves the submitted prompt and shows no raw JSON parser error.
- Browser: HTML 502 displays a Korean response error; valid mocked JSON renders one event
  and enables registration. Malformed JSON produces a localized response error.
- Shared response helper covers both AI parse and plan calls and status/identity fetches.
- `gh secret list --repo baekjungi/MapDule --json name`: existing app-specific deployment
  token name confirmed; no secret values were read.
- `gh api repos/baekjungi/MapDule/actions/permissions`: Actions enabled.
- `az staticwebapp show`: existing Free app in East Asia and expected production hostname confirmed.
- `az staticwebapp environment list`: existing default production environment is Ready.
- Static permission review: parse and plan routes require the authenticated role.
  The existing deployment workflow is unchanged. No infrastructure templates, managed identities
  or Azure RBAC assignments are created or changed by this code-only update.
- Production pre-fix reproduction: unauthenticated POST `/api/ai/parse` returns HTTP 401
  with `text/html`; this is the response the previous UI incorrectly tried to parse as JSON.
- Real authenticated OpenAI inference is not claimed by mocked browser tests.
