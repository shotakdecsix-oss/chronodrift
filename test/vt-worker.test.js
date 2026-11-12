'use strict';
// vt.js の変換を Worker(vt-worker.js)で行う経路のテスト。合成タイルで、Workerの結果がメイン変換と一致することと、
// 失敗の伝わり方・Workerが死んだ時のメイン変換への切り替えを確かめる。
const { test, after } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { Worker: NodeWorker } = require('node:worker_threads');
const { makeFetch } = require('./helpers/vt-fixture');

const ROOT = path.join(__dirname, '..');
const BAD_X = Math.floor((139.9 + 180) / 360 * 16384); // この列のタイルは500を返す
// 指定の経緯度を含むz14タイル1枚ぶんのbbox("minLat,minLon,maxLat,maxLon")。タイル全体を覆わないと、範囲外の建物は出力に含まれない
function tileBox(lon, lat) {
  const N = 16384, r = lat * Math.PI / 180;
  const x = Math.floor((lon + 180) / 360 * N), y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N);
  const la = (yy) => Math.atan(Math.sinh(Math.PI * (1 - 2 * yy / N))) * 180 / Math.PI;
  const e = 1e-7; // ちょうど境界だと隣のタイルまで含まれる
  return [la(y + 1) + e, x / N * 360 - 180 + e, la(y) - e, (x + 1) / N * 360 - 180 - e].join(',');
}
const GOOD = tileBox(139.76, 35.68), BAD = tileBox(139.9, 35.68);

const store = new Map();
class FakeWorker { // ブラウザのWorkerと同じ形(onmessage/onerror/postMessage/terminate)
  constructor() {
    FakeWorker.last = this;
    this.w = new NodeWorker(path.join(__dirname, 'helpers', 'vt-worker-shim.js'),
      { workerData: { file: path.join(ROOT, 'js/core/vt-worker.js'), fixture: { badX: BAD_X } } });
    this.w.on('message', (m) => { if (m.t === 'part') FakeWorker.parts++; if (this.onmessage) this.onmessage({ data: m }); });
    this.w.on('error', (e) => { if (this.onerror) this.onerror({ message: String(e && e.message) }); });
  }
  postMessage(m) { this.w.postMessage(m); }
  terminate() { return this.w.terminate(); }
}
FakeWorker.parts = 0;

globalThis.Worker = FakeWorker;
globalThis.document = { getElementById: () => null };
globalThis.location = { search: '' };
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
globalThis.fetch = makeFetch({ badX: BAD_X });
const warn = console.warn; console.warn = () => {};
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/core/vt.js'), 'utf8'), { filename: 'vt.js' });
const run = (code) => vm.runInThisContext(code);
after(() => { console.warn = warn; if (FakeWorker.last) FakeWorker.last.terminate(); });

test('Workerの結果がメインで変換した結果と一致し、小分けで届き、TileJSONの保存を頼まれる', async () => {
  assert.strictEqual(run('VT_WORKER_WANT'), true);
  const res = await run('vtLoadBatch')([GOOD]);
  assert.ok(res && res.vt === true, 'Workerからの結果');
  assert.ok(res.elements.length > 3000, '建物3000棟+道路: ' + res.elements.length);
  assert.ok(FakeWorker.parts >= 3, '分割された通数: ' + FakeWorker.parts);
  assert.ok(JSON.parse(store.get('iseharaVtTpl')).url.includes('{z}'), 'WorkerがTileJSONを取り直してメインのlocalStorageへ保存');
  assert.strictEqual(run('vtStats.recvN'), 1);
  assert.ok(run('vtStats.tiles') >= 1 && run('vtStats.convMs') > 0, 'Worker側の統計がメインへ反映される');
  const ref = await run('_vtBatchCore')([GOOD], undefined); // メインでの変換(基準)
  assert.deepStrictEqual(res.elements, ref.elements);
  assert.deepStrictEqual(res.z14, ref.z14);
});

test('Workerでの失敗は例外として伝わり、vtLoadBatchはnullを返して失敗を数える', async () => {
  const r = await run('vtLoadBatch')([BAD]);
  assert.strictEqual(r, null);
  assert.strictEqual(run('vtStats.fail'), 1);
  assert.match(run('vtStats.lastErr'), /HTTP 500/);
});

test('Workerが処理中に死んでも、メインで変換し直して結果を返す(失敗には数えない)', async () => {
  const failBefore = run('vtStats.fail');
  const p = run('vtLoadBatch')([GOOD]);
  run('_vtWkKill')('テスト');
  const res = await p;
  assert.ok(res && res.vt === true && res.elements.length > 3000);
  assert.strictEqual(run('_vtWkDead'), true);
  assert.strictEqual(run('vtStats.fail'), failBefore);
  const again = await run('vtLoadBatch')([GOOD]); // 以降はメインで変換
  assert.deepStrictEqual(again.elements, res.elements);
});
