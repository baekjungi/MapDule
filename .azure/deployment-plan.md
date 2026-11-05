# MapDule production update

Status: Validated

## 1. Scope and approval

The user requested fixing the AI HTML/JSON response error and deploying the integrated application on 2026-11-05.
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

- Handle 401/403 and authentication redirects before attempting JSON parsing.
- Show Korean sign-in links for protected AI parse and plan calls.
- Handle HTML and malformed JSON responses explicitly without raw parser errors.
- Keep authenticated-only access on AI parse and plan routes.
- Include previously integrated family chat, Korean UI and server fixes.

## 5. Validation

- [x] All validation checks pass
  - [x] JavaScript syntax: npm run check
  - [x] Full regression suite: npm test
  - [x] Public asset build: npm run build
  - [x] Whitespace: git diff --check
  - [x] Browser: HTML 401, HTML gateway response, malformed JSON, JSON success and input preservation
  - [x] Existing pipeline and deployment token configuration
  - [x] Static role verification: authenticated roles retained; no IaC or RBAC changes

## 6. Deployment and verification

Commit the verified integrated changes, push normally to main and monitor the matching GitHub Actions run.
Verify production assets and endpoints, then reproduce the original unauthenticated scenario in the browser.
Do not claim successful authenticated Azure OpenAI inference unless it has actually been exercised.
Rollback, if needed, uses a normal revert commit after identifying the failed deployment; no destructive Git commands.

## 7. Validation Proof

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
