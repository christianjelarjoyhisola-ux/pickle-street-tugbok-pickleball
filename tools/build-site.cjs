'use strict';
const fs = require('node:fs');
const path = require('node:path');
const files = require('./site-files.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
// Refuse stale, unrecognized artifacts instead of silently shipping old runtime files.
function validateExisting(dir) {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, {withFileTypes:true})) {
    const file = path.join(dir, item.name);
    if (item.isSymbolicLink()) throw new Error('Build output must not contain links.');
    if (item.isDirectory()) validateExisting(file);
    else if (!files.includes(path.relative(output, file).split(path.sep).join('/'))) {
      throw new Error('Unexpected build artifact: ' + path.relative(output, file));
    }
  }
}
validateExisting(output);
for (const file of files) {
  const source = path.join(root, file);
  if (!fs.statSync(source).isFile()) throw new Error('Missing site file: ' + file);
  const destination = path.join(output, file);
  fs.mkdirSync(path.dirname(destination), {recursive:true});
  fs.copyFileSync(source, destination);
}
console.log('Built Pickle Street Tugbok: ' + files.length + ' public files. Reference code and database tools are excluded.');
