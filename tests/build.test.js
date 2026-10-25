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

test('Azure Static Web Apps protects AI parsing with authentication', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const configPath = path.join(projectRoot, 'staticwebapp.config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const parseRoute = config.routes.find((route) => route.route === '/api/ai/parse');

  assert.deepEqual(parseRoute?.allowedRoles, ['authenticated']);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(projectRoot, 'dist', 'staticwebapp.config.json'), 'utf8')).routes,
    config.routes
  );
});