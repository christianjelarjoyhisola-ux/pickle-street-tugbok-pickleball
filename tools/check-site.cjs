'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const files = require('./site-files.cjs');
const root = path.resolve(__dirname, '..');
let scripts = 0;
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file));
  if (file === '_worker.js') {
    const workerSource = source.toString().replace(/^export\s+default\s+/, 'return ');
    new vm.Script(`(function(){${workerSource}\n})`, {filename:file});
    scripts++;
  } else if (file.endsWith('.js')) {
    new vm.Script(source.toString(), {filename:file});
    scripts++;
  }
  if (!file.endsWith('.html')) continue;
  const html = source.toString();
  assert.match(html, /data-pb-data-scope="(?:public|manager|auth)"/, file + ' must declare its data scope');
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=|type=["']application\/ld\+json/i.test(match[1])) continue;
    new vm.Script(match[2], {filename:file + ' inline ' + ++scripts});
  }
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) {
    const value = match[1];
    if (/^(?:https?:|mailto:|tel:|data:|blob:|#|\$|javascript:)/i.test(value) || value.includes('${')) continue;
    const relative = value.split(/[?#]/)[0];
    if (!relative || !/\.[a-z0-9]{2,5}$/i.test(relative)) continue;
    assert.ok(files.includes(relative), file + ' references unpublished asset: ' + relative);
  }
  assert.ok(!html.includes('qhvrow'), file + ' must not use the reference database');
}
assert.ok(!files.some(file => /^(feature-preview\/|supabase\/|operations\/|\.env|host\.html|player-live\.html)/.test(file)));
console.log('Checked ' + scripts + ' scripts and all page asset links.');
