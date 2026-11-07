# MapDule production update

Status: Validated

## 1. Scope and approval

The user requested finding and fixing features that look available but do not work on 2026-11-05.
The latest user request is to deploy the current application update on 2026-11-05.
Update the existing application only. Preserve the existing design, family chat, Korean UI and server reliability fixes.
Do not create, delete or reconfigure Azure infrastructure or expose application secrets.

Current request (2026-11-07): commit and push the implemented route, midpoint and
departure-push update to main, then verify the existing deployment pipeline.
Keep all current Azure resources and secrets unchanged. Real route keys and the
external push scheduler remain operator configuration, not part of this redeploy.

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

## 5. Validation

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
Verify production assets and endpoints, then exercise actual unauthenticated AI inference and corrected form behavior.
Do not claim successful Azure OpenAI inference unless it has actually been exercised.
Rollback, if needed, uses a normal revert commit after identifying the failed deployment; no destructive Git commands.

## 7. Validation Proof

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
