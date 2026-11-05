const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

test('build output contains only browser assets', () => {
  const projectRoot = path.resolve(__dirname, '..');
  execFileSync(process.execPath, ['scripts/stage-static.js'], { cwd: projectRoot });

  const outputFiles = fs.readdirSync(path.join(projectRoot, 'dist')).sort();
  assert.deepEqual(outputFiles, ['app.js', 'family.css', 'family.js', 'index.html', 'staticwebapp.config.json', 'styles.css']);
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

test('Azure Static Web Apps protects AI parsing with authentication', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const configPath = path.join(projectRoot, 'staticwebapp.config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const parseRoute = config.routes.find((route) => route.route === '/api/ai/parse');
  const planRoute = config.routes.find((route) => route.route === '/api/ai/plan');

  assert.deepEqual(parseRoute?.allowedRoles, ['authenticated']);
  assert.deepEqual(planRoute?.allowedRoles, ['authenticated']);
  assert.match(config.globalHeaders['Content-Security-Policy'], /upgrade-insecure-requests/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(projectRoot, 'dist', 'staticwebapp.config.json'), 'utf8')).routes,
    config.routes
  );

  const vercelConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'vercel.json'), 'utf8'));
  const vercelCsp = vercelConfig.headers[0].headers.find((header) => header.key === 'Content-Security-Policy');
  assert.match(vercelCsp?.value || '', /upgrade-insecure-requests/);
});