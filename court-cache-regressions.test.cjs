'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sourcePath = require('node:path').join(__dirname, 'supabase-config.js');
const source = fs.readFileSync(sourcePath, 'utf8');
function extract(name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, 'Missing actual function ' + name);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, 'Missing function end ' + name);
  return source.slice(start, end + 2);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const context = { Date, structuredClone, Map };
  vm.createContext(context);
  vm.runInContext('const _pbFastCache = new Map();\n' +
    ['_pbClone', '_pbCacheKey', '_pbCached', '_pbClearFastCache'].map(extract).join('\n'), context);
  return context;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('an invalidated old court response cannot resurrect the pre-promo cache', async () => {
  const c = harness(), oldResponse = deferred();
  const oldRead = c._pbCached('courts', {}, 60000, () => oldResponse.promise);
  await flush();
  c._pbClearFastCache(['courts']);
  oldResponse.resolve([{ rate: 200 }]);
  await oldRead;
  let freshLoads = 0;
  const current = await c._pbCached('courts', {}, 60000, () => {
    freshLoads += 1;
    return [{ rate: 150 }];
  });
  assert.equal(freshLoads, 1, 'Invalidation must require a fresh backend read');
  assert.equal(current[0].rate, 150);
});
test('late old success cannot replace a newer in-flight court response', async () => {
  const c = harness(), oldResponse = deferred(), newResponse = deferred();
  const oldRead = c._pbCached('courts', {}, 60000, () => oldResponse.promise);
  await flush();
  c._pbClearFastCache(['courts']);
  const newRead = c._pbCached('courts', {}, 60000, () => newResponse.promise);
  await flush();
  oldResponse.resolve([{ rate: 200 }]);
  await oldRead;
  let duplicateLoads = 0;
  const following = c._pbCached('courts', {}, 60000, () => {
    duplicateLoads += 1;
    return [{ rate: 999 }];
  });
  newResponse.resolve([{ rate: 150 }]);
  await newRead;
  assert.equal((await following)[0].rate, 150, 'Follower must join the current request');
  assert.equal(duplicateLoads, 0);
});
test('late old rejection cannot delete a newer successful court cache entry', async () => {
  const c = harness(), oldResponse = deferred();
  const oldRead = c._pbCached('courts', {}, 60000, () => oldResponse.promise);
  const rejected = assert.rejects(oldRead, /Old request failed/);
  await flush();
  c._pbClearFastCache(['courts']);
  await c._pbCached('courts', {}, 60000, () => [{ rate: 150 }]);
  oldResponse.reject(new Error('Old request failed'));
  await rejected;
  let replacementLoads = 0;
  const current = await c._pbCached('courts', {}, 60000, () => {
    replacementLoads += 1;
    return [{ rate: 999 }];
  });
  assert.equal(replacementLoads, 0, 'A stale failure must not delete a newer entry');
  assert.equal(current[0].rate, 150);
});
