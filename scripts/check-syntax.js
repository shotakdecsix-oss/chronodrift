// js/ 以下とサーバーの全JSを node --check で構文検査する(npm test から呼ばれる)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(path.join(root, 'js'));
files.push(path.join(root, 'server', 'server.js'));
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    bad++;
    console.error('[syntax] ' + path.relative(root, f) + '\n' + String(e.stderr || e.message));
  }
}
console.log(`[syntax] ${files.length - bad}/${files.length} OK`);
process.exit(bad ? 1 : 0);
