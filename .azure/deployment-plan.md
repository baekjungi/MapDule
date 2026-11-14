# MapDule production update

Status: Validated

## 1. Scope and approval

Current follow-up (2026-11-14): deploy the removal of meeting-place
recommendations and the subsequent calendar, event editor, AI and family UI
simplifications. Keep ordinary place search, route estimates, existing data,
family sharing and notifications. Use the same main-branch CI/CD target and
deployment identity. Do not change Azure resources, settings, roles or secrets.

Current request (2026-11-14): deploy the fixes implemented in this conversation:
reliable departure-push retries and serialized browser reservations; cross-date
calendar search; removal of redundant editor and mock recommendations; accessible
data management; Fetch Metadata API guards and same-origin resource headers.
The user's deployment request authorizes updating the existing main/site through
the existing GitHub Actions pipeline. Exclude the historical patch and local
handoff notes. Preserve Azure resources, application settings, identities and secrets.

The user requested finding and fixing features that look available but do not work on 2026-11-05.
The latest user request is to deploy the current application update on 2026-11-05.
Update the existing application only. Preserve the existing design, family chat, Korean UI and server reliability fixes.
Do not create, delete or reconfigure Azure infrastructure or expose application secrets.

Current request (2026-11-07): commit and push the implemented route, midpoint and
departure-push update to main, then verify the existing deployment pipeline.
Keep all current Azure resources and secrets unchanged. Real route keys and the
external push scheduler remain operator configuration, not part of this redeploy.

Current request (2026-11-08): simplify the mobile UI, require explicit walk/car/transit
selection before every departure, improve location consent and feedback, test, commit,
push and redeploy through the existing pipeline. Concurrent notification work is
excluded from this commit; preserve those unstaged changes.

Current follow-up (2026-11-08): deploy the remaining notification changes in
departure-push.js and family.js with their six browser regression tests and related
documentation. Exclude the historical patch and local handoff notes. Preserve all
existing Azure resources, application settings and secrets.

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

- Remove the meeting-place recommendation menu, view, styles, module and dedicated
  nearby/midpoint endpoints; retain place search and route estimation.
- Deduplicate calendar actions and progressively disclose optional event fields.
- Simplify AI registration, preserve stale-result protection and manual fallback,
  and separate optional saved-day calculations.
- Prioritize family joining and collapse creation/management controls while
  preserving their actions, values and refresh disclosure state.
- Include regression tests and directly related documentation for these changes.
- Fix event-form validation so corrected times and titles can be saved.
- Permit place re-search after changing an in-flight query; ignore stale search results.
- Preserve native keyboard activation on calendar event buttons.
- Refresh the map when the selected day has no events.
- Reject malformed backups before any storage changes, without silently importing a subset.
- Invalidate old AI previews and responses when the prompt changes.
- Include the current family permission, read-state, GPS/notification and repeat-generation regression fixes.
- Include the server-owned route-estimation module, AI summary fallback and mobile refresh accessibility fixes.
- Include the completed frontend coordinate resolution and opt-in departure reminder follow-up.
- Preserve existing changes; deploy the reviewed application files and their tests together without exposing local data or secrets.
- Simplify mobile header navigation and collapse secondary family settings.
- Select a transport mode before free, event, return and alarm-triggered departures.
- Request location only after confirmation, with settings retry, Escape cancellation
  and persistent map accuracy/error feedback.

## 5. Validation

### 2026-11-14 update

- [x] Current follow-up validation checks pass
  - [x] JavaScript syntax, full regression suite and whitespace
  - [x] Public asset build and API dependency loading
  - [x] Node.js 22 API runtime, CI compatibility and unchanged package dependencies
  - [x] Existing main alignment, push permission and deployment-secret presence
  - [x] Unchanged deployment target, identities, resources, roles and settings
  - [x] Current validation proof and browser evidence recorded

- [x] Current JavaScript syntax, full regression suite and whitespace checks
- [x] Public asset build and API dependency loading
- [x] Existing main, workflow and deployment-secret presence
- [x] Node.js 22 managed API runtime and CI compatibility
- [x] Unchanged deployment identity and resource configuration
- [x] Validation proof recorded before normal commit and push

- [x] All validation checks pass
  - [x] JavaScript syntax: npm run check
  - [x] Full regression suite: npm test
  - [x] Public asset build: npm run build
  - [x] Whitespace: git diff --check
  - [x] Browser workflow, route estimation and family regression tests
  - [x] Existing pipeline and deployment token configuration
  - [x] Static role verification: guest routes enabled; API secrets remain server-side; no Azure RBAC changes
  - [x] API lockfile installation: npm ci --prefix api --ignore-scripts

Current update: Kakao/ODsay route adapters and fallback metadata; midpoint place
search and travel comparison; optional departure Web Push API and service worker;
mobile entry controls; focused regression tests and configuration documentation.

## 6. Deployment and verification

Commit the verified application update, push normally to main and monitor the matching GitHub Actions run.
Verify exact production assets, retained status/search APIs, retired recommendation
endpoints and the simplified desktop/mobile interface without changing production
user data. Use mocked AI inference for UI validation rather than paid provider calls.
Do not claim successful Azure OpenAI inference unless it has actually been exercised.
Rollback, if needed, uses a normal revert commit after identifying the failed deployment; no destructive Git commands.

## 7. Validation Proof

### 2026-11-14 recommendation removal and interface simplification

Validation executed at 2026-11-14T10:29:43+09:00 through azure-validate.

- `npm test`: 170 tests passed, zero failures.
- `npm run check`, `npm run build` and `git diff --check`: passed.
- API dependencies `@azure/functions` and `web-push` load successfully.
  No dependency or runtime-major changes are included. Local Node.js is 24.15.0;
  the existing managed API configuration and pre-deploy CI both use Node.js 22.
  Package engine ranges include 22; the CI gate must pass on 22 before upload.
- Local and remote main start from 17b346387f32b01e541ccdc9af7293c39699c79d.
  GitHub push permission and the existing app-specific deployment-secret name
  were verified without reading secret values.
- Azure resource lookup confirms the existing Static Web App mapdule-baekjungi
  in rg-mapdule-prod, East Asia. No resources are provisioned or reconfigured.
  No new identities, RBAC assignments, application settings or secrets are changed;
  provisioning and new-role propagation checks are not applicable.
- Tests verify removed nearby/midpoint operations and Functions registrations,
  retained place search/address fallback, API security/body limits and routing.
- Local browser verification covered 320px/360px mobile and desktop layouts,
  keyboard disclosure and validation, ordinary event persistence, optional-field
  preservation, AI preview invalidation, successful registration/reset, manual
  fallback and accessible family joining/creation without submitting family changes.
- AI inference was mocked for browser checks; no new paid AI inference or physical
  closed-app notification delivery is claimed. Production verification must avoid
  creating or deleting user data and compare served assets to the release commit.
- The historical patch and local handoff notes remain excluded from deployment.

### 2026-11-14 reliability, search and security update

Validation executed at 2026-11-14T10:03:22+09:00 through azure-validate.

- `npm run check`: passed.
- `npm test`: 163 tests passed, zero failures.
- `npm run build` and `git diff --check`: passed.
- `@azure/functions` and `web-push` dependencies load successfully from api.
- Local Node.js is 24.15.0. The deployed managed API is explicitly configured
  for Node.js 22 and GitHub validation uses Node.js 22 before upload. Package
  engine ranges include 22; no runtime major or dependency changes are introduced.
- GitHub authentication, push permission and the existing app-specific deployment
  secret name were verified without reading secret values. Local and remote main
  both start from e27b03728f0e9982aea8001e0e164c174b58ca03.
- Browser verification covered desktop and 320px mobile search, editing and
  persistence, restoring the prior calendar view, category filters, data-management
  navigation, explicit deletion confirmation and AI failure/manual-input fallback.
- API tests cover cross-site/sibling-site rejection before body reads, same-origin
  and non-browser callers, existing authentication, request limits and push dispatch.
- Static identity review: no infrastructure, role assignments, deployment identities,
  application settings or secrets are changed. Existing CI/CD upload token and
  target remain unchanged. No provisioning or new-role checks are applicable.
- Local Azure control-plane lookup could not authenticate. This code-only CI/CD
  deployment uses the already-configured GitHub deployment token instead; live
  public endpoint and exact asset verification are required after the matching run.
- Historical patch and local handoff notes are excluded from staging and deployment.
  Real-device closed-app notification delivery and new live AI inference are not
  claimed by these deployment checks.

### 2026-11-08 notification follow-up

Validation recorded at 2026-11-08T16:44:03+09:00 through azure-validate.

- Focused notification/departure/family regression run: 36 tests passed.
- `npm run check`: passed. `npm test`: 138 tests passed, zero failures.
- `npm run build` and `git diff --check`: passed.
- GitHub authentication and the existing deployment-token secret name verified.
- Fetched main and local HEAD match before committing; normal push only.
- Only notification browser scripts, their six regression tests, related deployment
  documentation and validation records are included. Historical patch and handoff
  notes remain untracked and are not shipped.
- Existing CI validates the exact committed snapshot before uploading dist and api.
- Static role verification: unchanged anonymous API routes, geolocation policy and
  existing deployment identity. No IaC, Azure RBAC, resources or secret values change;
  provisioning/subscription selection and live new-role checks are not applicable.
- Production asset equality and matching pipeline completion must be verified after
  push. Closed-app real-device delivery is not claimed by these automated checks.

Validation date: 2026-11-05, approximately 22:02-22:05 Asia/Seoul.

- `npm run check`, `npm test`, `npm run build`, `git diff --check`: passed.
- All 84 tests in the shared worktree passed, including eight new browser-workflow
  regressions and concurrent family tests. CI will verify the exact committed snapshot.
- Reproduced invalid-time error surviving a correction before the fix. After the fix,
  a corrected 15:00-16:00 meeting saved, survived reload and could be edited again.
- Browser rejected whitespace-only titles and allowed saving after correction.
- Reproduced place search remaining disabled after editing the query. After the fix,
  a second query could run and only its results could be selected.
- Reproduced malformed date/time backup being accepted. After the fix, import displayed
  a Korean error, opened no restore confirmation and left existing storage unchanged.
- Browser and unit tests confirmed editing the AI prompt disables stale registration;
  a delayed response for the old prompt cannot restore the old preview.
- Unit tests cover leap days, all-day events, duplicate IDs, invalid dates/times/coordinates,
  nested calendar keyboard handling and map refresh for an empty day.
- Production Kakao map was created successfully; the local audit origin is not on
  the configured Kakao domain allowlist, so local place-query race tests use controlled responses.
- Existing production workflow succeeded for current main. Deployment target/token are
  unchanged. No infrastructure, Azure RBAC, application roles or API-secret handling changes.

### Current deployment validation

Validated at 2026-11-05T22:15:32+09:00 through the azure-validate workflow.

- `npm run check`: passed, including the new route-estimation module.
- `npm test`: all 93 tests passed, zero failures, including ten browser-workflow regressions.
- The exact isolated workflow-fix app snapshot also passed all 13 targeted workflow/AI response tests.
- `npm run build`: passed; output contains only the six public browser assets.
- `git diff --check`: passed; editor diagnostics report no errors in the changed application modules.
- Existing GitHub Actions workflow and app-specific deployment Secret are present.
- Production pipeline `42033746494` for integration commit `ea97f8a` succeeded.
- Follow-up commit `36d212c` completes frontend/server integration and preserves these workflow fixes.
- No Azure provisioning, SKU, subscription, region, RBAC or secret-value changes are requested.
- CI will repeat syntax, tests and build against the exact pushed commit before deployment.

### 2026-11-07 route, midpoint and departure-push redeployment

Validation recorded at 2026-11-07T23:39:54+09:00 through azure-validate.

- `npm ci --prefix api --ignore-scripts`: passed; 21 packages audited, zero vulnerabilities.
- `npm run check`: passed for all application and API modules, including the new functions.
- `npm test`: 112 tests passed, zero failures.
- `npm run build`: passed; ten public browser assets, including push script, worker, manifest and icon.
- `git diff --check`: passed; the key example contains placeholders or empty values only.
- The installed Web Push package loads and exports `sendNotification` in the Node runtime.
- GitHub authentication works and the existing app-specific deployment secret is present.
- Local main and fetched origin/main match before committing; use a normal commit and push, never force-push.
- Existing pipeline validates on Node 22 before deployment; CI verifies the exact pushed commit.
- Local browser confirmed midpoint ranking, selected-place modal prefill, unconfigured push fallback,
  and layouts without horizontal overflow at 360, 390 and 1280 CSS-pixel viewport widths.
- Existing Azure resources, app roles, RBAC and secret values are unchanged. Deployment uses the
  existing GitHub Actions token for the same Static Web App; no provisioning commands are needed.
- Actual external-route calls and closed-app push delivery require operator configuration and
  were not validated here. Monitor the pipeline, then verify production assets and the new APIs.

### 2026-11-08 mobile departure redeployment

Validated through azure-validate on 2026-11-08 (Asia/Seoul).

- `npm run check`, `npm test`, `npm run build`, `git diff --cached --check`: passed
  on the isolated staged application snapshot; 132 tests passed, zero failures.
- The shared worktree additionally passed all 138 tests. Concurrent notification
  changes and their six tests remain unstaged and are excluded from this deployment.
- Chromium tested the exact staged snapshot at 320, 360, 390, 430, 680 and 1280px:
  no horizontal overflow, accessible more menu, collapsible family settings whose
  open state survives refresh, and departure actions visible within the mobile sheet.
- Browser tests with controlled family/GPS responses verified walk/car/transit
  selection reaches the trip API; closing the chooser requests no GPS; event
  departures use the same chooser; blocked permission and GPS timeout save no trip.
- Map location feedback reports accuracy and supports cancellation without leaving
  the button disabled. No uncaught browser errors were observed.
- Existing main and origin/main matched before staging. GitHub authentication and
  the existing Static Web App deployment-token secret were verified.
- Deployment keeps the same existing GitHub Actions target and token; no Azure
  infrastructure, SKU, roles, storage schema or secret values change. Static
  geolocation permissions and guest API access remain intact. No managed-identity
  or role-assignment provisioning is involved in this frontend-only update.
- Real-device GPS accuracy, external route providers and closed-app push delivery
  are not claimed by the controlled browser tests. Verify the matching workflow
  and production asset hashes after pushing.
