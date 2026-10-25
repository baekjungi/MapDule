const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = path.join(projectRoot, 'dist');
const publicFiles = ['index.html', 'app.js', 'styles.css', 'family.js', 'family.css', 'staticwebapp.config.json'];

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });

for (const file of publicFiles) {
  fs.copyFileSync(path.join(projectRoot, file), path.join(outputDirectory, file));
}