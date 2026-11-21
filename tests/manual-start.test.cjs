const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setImmediate: settle } = require('node:timers/promises');

const source = fs.readFileSync(path.join(__dirname, '..', 'helper-core.js'), 'utf8');
const course = 'https://wisdom-mooc.zhihuishu.com/study/index?recruitAndCourseId=demo';
const runKey = 'zhsVideoRunV1';
const completed = Array.from({length: 11}, (_, i) => '0:lesson:1.' + (i + 1));

async function openCourse(saved) {
  const controls = new Map();
  const panel = {style: {}, attachShadow: () => ({getElementById(id) {
    if (!controls.has(id)) controls.set(id, {});
    return controls.get(id);
  }})};
  const visible = {isConnected: true, getClientRects: () => [{}], closest: () => null};
  const lessons = ['2.4','2.5','2.6'].map(number => ({
    ...visible, innerText: number + ' 课程', querySelector: () => null,
    matches: selector => selector.includes('.current') && number === '2.5'
  }));
  const chapter = {querySelectorAll: () => lessons};
  const video = {...visible, paused: true, ended: false, currentTime: 1.326, duration: 698,
    readyState: 4, playbackRate: 1, defaultPlaybackRate: 1, addEventListener() {},
    async play() { this.paused = false; }, pause() { this.paused = true; }};
  const document = {
    documentElement: {append() {}}, getElementById: () => null, createElement: () => panel, addEventListener() {},
    querySelectorAll(selector) {
      if (selector === 'video') return [video];
      if (selector === '.chapter-content') return [chapter];
      return [];
    }
  };
  const values = {[runKey]: {id: 'old-run', courseUrl: course, enabled: false, phase: 'course',
    leaseUntil: 0, owner: null, updatedAt: Date.now(), done: completed, testsDone: [], tasks: [], ...saved}};
  const api = {clientId: 'document', tabId: 7, onValuesChanged() {}, onAuthorityLost() {}, GM_registerMenuCommand() {},
    GM_getValue: (key, fallback) => structuredClone(values[key] ?? fallback),
    GM_setValue: (key, value) => { values[key] = structuredClone(value); },
    leaseVerified: (id, owner) => values[runKey].enabled && id === values[runKey].id && owner === values[runKey].owner,
    async flush() {}
  };
  const globals = {document, location: new URL(course), URL, crypto, setTimeout, clearTimeout,
    addEventListener() {}, setInterval() {}, getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    chrome: {runtime: {getManifest: () => ({version: 'test'})}},
    ZhsUnifiedRuntime: {ready: Promise.resolve(api), onBootstrapState: () => () => {}}
  };
  vm.runInNewContext(source, globals, {filename: 'helper-core.js'});
  await settle();
  return {controls, video, values};
}

for (const [description, saved] of [
  ['paused on 2.4', {cursor: '0:lesson:2.4', pending: null}],
  ['old switch to 2.6 still pending', {cursor: '0:lesson:2.4', pending: {kind: 'lesson', key: '0:lesson:2.6'}}]
]) {
  test('manual Start plays the selected 2.5 with ' + description, async () => {
    const {controls, video, values} = await openCourse(saved);
    controls.get('start').onclick();
    await settle();
    const run = values[runKey];
    assert.equal(run.enabled, true, controls.get('status').textContent);
    assert.equal(run.cursor, '0:lesson:2.5');
    assert.equal(run.pending, null);
    assert.deepEqual(run.done, completed);
    assert.equal(video.paused, false);
    assert.equal(video.currentTime, 1.326);
  });
}
