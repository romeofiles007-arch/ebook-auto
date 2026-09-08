import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const url = 'chrome-extension://test/ui/studio.html';

async function openStudio({ existing = true, live = true, status = 'complete', discarded = false, legacy = false } = {}) {
  const calls = [];
  const event = { addListener() {} };
  let listener;
  const tab = { id: 7, windowId: 1, url, status, discarded };
  const chrome = {
    runtime: {
      getURL: () => url, onInstalled: event,
      onMessage: { addListener(fn) { listener = fn; } },
      ...(!legacy ? { getContexts: async (filter) => {
        assert.deepEqual(JSON.parse(JSON.stringify(filter)), { contextTypes: ['TAB'], tabIds: [7] });
        return live ? [{ tabId: 7 }] : [];
      } } : {}),
    },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    tabs: {
      onActivated: event, onUpdated: event, onRemoved: event,
      query: async () => existing ? [tab] : [],
      create: async (opts) => { calls.push({ create: opts }); return tab; },
      update: async (id, opts) => { calls.push({ update: opts }); return { ...tab, ...opts }; },
    },
    windows: { update: async () => {} },
    alarms: { create() {}, onAlarm: event },
  };
  vm.runInNewContext(source, { chrome });
  const result = await new Promise((resolve) => listener({ type: 'sw.openStudio' }, {}, resolve));
  assert.equal(result.ok, true, result.error);
  return JSON.parse(JSON.stringify(calls));
}

test('reopens a failed Studio navigation in the same tab', async () => {
  assert.deepEqual(await openStudio({ live: false }), [{ update: { url, active: true } }]);
});
test('only focuses a healthy Studio without interrupting work', async () => {
  assert.deepEqual(await openStudio(), [{ update: { active: true } }]);
});
test('does not restart Studio while it is loading', async () => {
  assert.deepEqual(await openStudio({ live: false, status: 'loading' }), [{ update: { active: true } }]);
});
test('restores discarded Studio and creates a tab when missing', async () => {
  assert.deepEqual(await openStudio({ discarded: true }), [{ update: { url, active: true } }]);
  assert.deepEqual(await openStudio({ existing: false }), [{ create: { url, pinned: true, active: true } }]);
});
test('older Chrome without getContexts still opens Studio', async () => {
  assert.deepEqual(await openStudio({ legacy: true }), [{ update: { active: true } }]);
});
