const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const initialUrl = 'https://wisdom-mooc.zhihuishu.com/study/index?recruitAndCourseId=demo';
const runKey = 'zhsVideoRunV1';
const storeKey = 'zhsCoreStateV1';
const extensionId = 'test-extension';
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function event() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), fire: (...args) => listeners.forEach(fn => fn(...args)) };
}

// Only the browser APIs are simulated. Storage validation, the write queue and both
// ends of extension messaging run the shipped scripts.
function browser() {
  const background = event(), onUpdated = event(), onRemoved = event();
  const tab = {id: 7, status: 'complete', url: initialUrl};
  const storage = {};
  let current, saveError, whileReadingTab, loseWriteReply = false;
  const globals = {URL, structuredClone, crypto, setTimeout, clearTimeout};
  const getURL = file => 'chrome-extension://' + extensionId + '/' + file;
  const worker = vm.createContext({...globals, chrome: {
    runtime: {id: extensionId, onMessage: background, getURL},
    storage: {local: {
      async setAccessLevel() {},
      async get() { return structuredClone(storage); },
      async set(update) {
        if (saveError) throw saveError;
        Object.assign(storage, structuredClone(update));
      }
    }},
    tabs: {
      onUpdated, onRemoved,
      async get() {
        const snapshot = {...tab};
        if (whileReadingTab) { const fn = whileReadingTab; whileReadingTab = null; fn(); }
        return snapshot;
      },
      async sendMessage(tabId, message, {frameId, documentId}) {
        if (tabId !== tab.id || frameId !== 0 || (documentId && documentId !== current.id)) {
          throw Error('No matching frame');
        }
        let answer;
        current.messages.fire(structuredClone(message), {id: extensionId}, value => { answer = value; });
        return structuredClone(answer);
      }
    }
  }});
  for (const file of ['protocol.js','core-background.js']) vm.runInContext(read(file), worker, {filename: file});

  function open(url = tab.url) {
    const doc = {id: crypto.randomUUID(), messages: event(), location: new URL(url)};
    current = doc;
    function send(message) {
      const sender = {id: extensionId, documentId: doc.id, documentLifecycle: 'active',
        frameId: 0, tab: {...tab}, url: doc.location.href};
      return new Promise((resolve, reject) => background.fire(structuredClone(message), sender, value => {
        if (loseWriteReply && message.type === 'zhs-core-set' && value.ok) {
          loseWriteReply = false;
          reject(Error('message channel closed'));
        } else resolve(structuredClone(value));
      }));
    }
    const content = vm.createContext({...globals, location: doc.location, chrome: {
      runtime: {id: extensionId, onMessage: doc.messages, sendMessage: send}
    }});
    vm.runInContext(read('runtime.js'), content, {filename: 'runtime.js'});
    return {id: doc.id, ready: content.ZhsUnifiedRuntime.ready};
  }
  function update(info) {
    Object.assign(tab, info);
    if (info.url) current.location.href = info.url;
    onUpdated.fire(tab.id, info, {...tab});
  }
  const options = message => new Promise(resolve => background.fire(message, {id: extensionId, url: getURL('options.html')}, resolve));
  return {open, update, storage, options, loseNextWriteReply: () => { loseWriteReply = true; },
    failSaves: () => { saveError = Error('storage unavailable'); },
    onNextTabRead: fn => { whileReadingTab = fn; }};
}

async function begin(page) {
  const api = await page.ready;
  api.GM_setValue(runKey, {id: 'run', phase: 'course', enabled: true, owner: page.id, courseUrl: initialUrl,
    updatedAt: Date.now(), leaseUntil: Date.now() + 15000, done: ['first']});
  await api.flush();
  return api;
}

test('same document can save after changing lesson URL, with shared input disabled', async () => {
  const b = browser(), page = b.open(), api = await begin(page);
  b.update({url: initialUrl + '&lesson=2'});
  api.GM_setValue(runKey, {...api.GM_getValue(runKey), done: ['first','second']});
  await api.flush();
  assert.deepEqual(b.storage[storeKey].values[runKey].done, ['first','second']);
  assert.equal(b.storage[storeKey].revisions[runKey], 2);
});

test('a write during a short loading interval is committed once and later writes still work', async () => {
  const b = browser(), page = b.open(), api = await begin(page);
  b.update({status: 'loading'});
  api.GM_setValue(runKey, {...api.GM_getValue(runKey), cursor: 'second'});
  const complete = setTimeout(() => b.update({status: 'complete'}), 20);
  try { await api.flush(); } finally { clearTimeout(complete); }
  api.GM_setValue(runKey, {...api.GM_getValue(runKey), cursor: 'third'});
  await api.flush();
  assert.equal(b.storage[storeKey].values[runKey].cursor, 'third');
  assert.equal(b.storage[storeKey].revisions[runKey], 3);
});

test('a same-course URL change during sender verification preserves the pending write', async () => {
  const b = browser(), page = b.open(), api = await begin(page);
  b.onNextTabRead(() => b.update({url: initialUrl + '#second'}));
  api.GM_setValue(runKey, {...api.GM_getValue(runKey), cursor: 'second'});
  await api.flush();
  assert.equal(b.storage[storeKey].values[runKey].cursor, 'second');
});

test('a reload at the identical URL rejects the old document and admits the new top document', async () => {
  const b = browser(), old = b.open(), oldApi = await begin(old);
  b.update({status: 'loading'});
  b.update({status: 'complete'});
  const replacement = b.open();
  const newApi = await replacement.ready;
  oldApi.GM_setValue(runKey, {...oldApi.GM_getValue(runKey), cursor: 'stale'});
  await assert.rejects(oldApi.flush());
  assert.equal(b.storage[storeKey].values[runKey].cursor, undefined);
  const config = {...newApi.GM_getValue('config'), mute: false};
  newApi.GM_setValue('config', config);
  await newApi.flush();
  assert.equal(b.storage[storeKey].values.config.mute, false);
});

test('changing course in place does not carry document authority to the new course', async () => {
  const b = browser(), page = b.open(), api = await begin(page);
  b.update({url: initialUrl.replace('=demo', '=other')});
  api.GM_setValue('config', {...api.GM_getValue('config'), mute: false});
  await assert.rejects(api.flush());
  assert.equal(b.storage[storeKey].values.config.mute, true);
});

test('a pause from settings cancels a checkpoint waiting for navigation', async () => {
  const b = browser(), page = b.open(), api = await begin(page);
  b.update({status: 'loading'});
  api.GM_setValue(runKey, {...api.GM_getValue(runKey), cursor: 'superseded'});
  const options = await b.options({type: 'zhs-options-get'});
  const saved = await b.options({type: 'zhs-options-save', expectedRevisions: options.revisions,
    config: {...options.config, mute: false}});
  assert.equal(saved.ok, true);
  b.update({status: 'complete'});
  await api.flush();
  assert.equal(api.GM_getValue(runKey).enabled, false);
  assert.equal(b.storage[storeKey].values[runKey].cursor, undefined);
  assert.equal(b.storage[storeKey].revisions[runKey], 2);
});

test('a lost acknowledgment after commit stops the queue without replaying the write', async () => {
  const b = browser(), page = b.open(), api = await begin(page);
  b.loseNextWriteReply();
  api.GM_setValue(runKey, {...api.GM_getValue(runKey), cursor: 'saved'});
  await assert.rejects(api.flush(), /message channel closed/);
  assert.equal(b.storage[storeKey].values[runKey].cursor, 'saved');
  assert.equal(b.storage[storeKey].revisions[runKey], 2);
});

test('an actual storage failure still stops writes and leaves the prior checkpoint intact', async () => {
  const b = browser(), page = b.open(), api = await begin(page);
  b.failSaves();
  api.GM_setValue(runKey, {...api.GM_getValue(runKey), done: []});
  await assert.rejects(api.flush(), /storage unavailable/);
  assert.throws(() => api.GM_setValue(runKey, {}), /storage unavailable/);
  assert.deepEqual(b.storage[storeKey].values[runKey].done, ['first']);
});
