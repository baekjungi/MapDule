const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

test('build output contains only browser assets', () => {
  const projectRoot = path.resolve(__dirname, '..');
  execFileSync(process.execPath, ['scripts/stage-static.js'], { cwd: projectRoot });

  const outputFiles = fs.readdirSync(path.join(projectRoot, 'dist')).sort();
  assert.deepEqual(outputFiles, ['app-icon.svg', 'app.js', 'departure-push.js', 'family.css', 'family.js', 'index.html', 'manifest.webmanifest', 'staticwebapp.config.json', 'styles.css', 'sw.js']);
});

test('meeting recommendations are removed while the secondary menu and font import remain', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.doesNotMatch(html, /midpoint|약속 지점|주변 카페/);
  assert.doesNotMatch(app, /initializeMidpoint|requestMobility|midpoint/);
  assert.doesNotMatch(styles, /midpoint|demo-result|people-times|\.orb\b/);
  assert.equal(fs.existsSync(path.join(root, 'api', 'src', 'midpoint.js')), false);
  assert.match(html, /aria-label="알림"/);
  assert.match(html, /aria-label="데이터 관리"/);
  assert.match(styles, /^@import url\(/);
  const familyStyles = fs.readFileSync(path.join(root, 'family.css'), 'utf8');
  assert.match(html, /aria-controls="top-secondary-actions"/);
  assert.match(familyStyles, /\.app-shell \.top-secondary-actions\{display:none/);
  assert.match(familyStyles, /\.app-shell \.more-open \.top-secondary-actions\{display:grid/);
});

test('calendar search and data management replace the orphan editor and fake demo features', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(html, /role="search" aria-label="일정 검색"/);
  assert.match(html, /aria-describedby="calendar-search-status"/);
  assert.match(html, /data-view="manual" aria-label="데이터 관리"/);
  assert.doesNotMatch(html, /음성 분석 정확도|AI 실시간 분석 완료|accept-quest|add-dinner|keep-original/);
  assert.doesNotMatch(app, /manual-event-form|manualEventForm|editingEventId/);
  assert.match(styles, /\.calendar-search-result \.event-badge-time\{display:inline\}/);
  assert.match(styles, /\.calendar-search input::-webkit-search-cancel-button\{appearance:none\}/);
  for (const id of ['export-ics', 'export-backup', 'import-backup', 'clear-local-data', 'backup-file']) {
    assert.ok(app.includes(`id="${id}"`), `Data management control missing: ${id}`);
  }
});

test('keeps the family refresh control accessible at narrow mobile widths', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(projectRoot, 'family.css'), 'utf8');

  assert.match(html, /class="sync-button" type="button" aria-label="가족 새로고침" title="가족 새로고침"/);
  assert.match(styles, /@media\(max-width:360px\)\{\.date-heading \.sync-button\{[^}]*flex:0 0 44px/);
});

test('calendar controls are deduplicated and optional event fields are progressively disclosed', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const familyStyles = fs.readFileSync(path.join(root, 'family.css'), 'utf8');
  assert.doesNotMatch(html, /sidebar-today-button/);
  assert.doesNotMatch(app, /sidebar-today-button/);
  assert.match(html, /class="calendar-today-button"/);
  assert.match(html, /class="nav-item ai-nav" data-view="ai"/);
  assert.match(familyStyles, /\.app-shell \.top-actions \.ai-register-button\{display:none\}/);
  assert.match(app, /<details class="event-advanced"/);
  const optionalFields = app.slice(app.indexOf('<details class="event-advanced"'), app.indexOf('</details>', app.indexOf('<details class="event-advanced"')));
  for (const name of ['calendarId', 'notes', 'repeatDays', 'departNotice', 'returnHome']) {
    assert.ok(optionalFields.includes(`name="${name}"`), `Missing optional field: ${name}`);
  }
  assert.match(optionalFields, /class="participant-options">\$\{participantOptions\}/);
  assert.match(styles, /\.event-advanced\{grid-column:1\/-1;min-width:0/);
});

test('AI entry keeps a single registration flow and separates optional saved-day calculations', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const family = fs.readFileSync(path.join(root, 'family.js'), 'utf8');
  assert.match(html, /class="ai-preview" aria-labelledby="ai-preview-title" hidden/);
  assert.match(html, /class="manual-link" type="button" data-manual-fallback>직접 입력으로 등록/);
  assert.equal((html.match(/data-manual-fallback/g) || []).length, 1);
  assert.doesNotMatch(app, /<button[^>]+data-manual-fallback/);
  assert.match(app, /<details class="ai-plan-tools">\s*<summary>저장된 일정의 이동 시간 계산/);
  assert.match(app, /document\.querySelector\('\.manual-link'\)\?\.addEventListener\('click', \(\) => openEventFormModal\('create'/);
  assert.match(family, /const moreOpen = section\.querySelector\('\.family-more-panel'\)\?\.open \?\? false;/);
});

test('closed mobile calendar menus stay out of keyboard and accessibility navigation', () => {
  const root = path.resolve(__dirname, '..');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

  assert.match(styles, /@media\(max-width:680px\)\{body\.calendar-visible \.calendar-sidebar\{visibility:hidden\}body\.calendar-visible\.sidebar-open \.calendar-sidebar\{visibility:visible\}\}/);
});

test('single-day event badges fit their available width before truncating long titles', () => {
  const root = path.resolve(__dirname, '..');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

  assert.match(styles, /\.single-day-view>\.event-badge\{width:100%;max-width:600px/);
});

test('family chat ships inside the original family assets with Korean UI', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'family.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'family.css'), 'utf8');
  assert.doesNotMatch(html, /(?:src|href)="family-chat\.(?:js|css)"/);
  assert.equal((script.match(/window\.MapDuleFamilyChat =/g) || []).length, 1);
  assert.ok(script.indexOf('window.MapDuleFamilyChat =') < script.indexOf('const CREDENTIAL_KEY'));
  assert.match(script, /엔터로 전송 · 시프트\+엔터로 줄바꿈/);
  assert.match(script, /month: 'long'/);
  assert.match(styles, /^@import url\('https:\/\/fonts\.googleapis\.com\/css2\?family=Noto\+Color\+Emoji/);
  assert.match(styles, /\.family-chat-send/);
});

test('Azure Static Web Apps allows guest AI access while preserving security headers', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const configPath = path.join(projectRoot, 'staticwebapp.config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const parseRoute = config.routes.find((route) => route.route === '/api/ai/parse');
  const planRoute = config.routes.find((route) => route.route === '/api/ai/plan');

  assert.deepEqual(parseRoute?.allowedRoles, ['anonymous']);
  assert.deepEqual(planRoute?.allowedRoles, ['anonymous']);
  assert.match(config.globalHeaders['Content-Security-Policy'], /upgrade-insecure-requests/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(projectRoot, 'dist', 'staticwebapp.config.json'), 'utf8')).routes,
    config.routes
  );

  const vercelConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'vercel.json'), 'utf8'));
  const vercelCsp = vercelConfig.headers[0].headers.find((header) => header.key === 'Content-Security-Policy');
  assert.match(vercelCsp?.value || '', /upgrade-insecure-requests/);
  assert.equal(config.globalHeaders['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(vercelConfig.headers[0].headers.find((header) => header.key === 'Cross-Origin-Resource-Policy')?.value, 'same-origin');
});