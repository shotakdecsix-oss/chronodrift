// part8.jsのタイル処理スケジューラ(スライス実行)を、疑似の時計とタイマーで動かして検査する。
// processTileDataSteps本体は重いので、1歩ごとに時計を進める偽物に差し替える(切れ目の入れ方と進め方だけを見る)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'legacy', 'part8.js'), 'utf8');
function between(a, b) {
  const i = src.indexOf(a), j = src.indexOf(b);
  assert.ok(i >= 0 && j > i, a + ' … ' + b);
  return src.slice(i, j);
}
const REGION1 = between('let _sliceDeadline = Infinity;', 'function* processTileDataSteps('); // 同期ラッパーと_tdBreak
const REGION2 = between('const OSM_READY_MAX = 6;', 'function processOSMTileQueue() {');   // 取り込み待ち〜スライス駆動

function makeEnv({ search = '', hidden = false } = {}) {
  const env = { clock: 100000, timers: [], queueCalls: 0, errors: [] };
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error: (...a) => env.errors.push(a) },
    performance: { now: () => env.clock },
    document: { hidden }, location: { search },
    setTimeout: (fn) => { env.timers.push(fn); return env.timers.length; },
    clearTimeout() {},
    OSM_TILE_M: 100,
    priorityDist2: (x, z) => x * x + z * z,
    processOSMTileQueue: () => { env.queueCalls++; },
    __advance: (ms) => { env.clock += ms; },
  });
  vm.runInContext(`
    let osmEpoch = 1, _curTileRush = false, _roadMeshCollector = null, _roadBuildingRemoveBatch = null;
    const _log = [];
    function* processTileDataSteps(d) {
      for (let i = 0; i < d.steps; i++) { __advance(d.stepMs); if (performance.now() >= _sliceDeadline) yield; }
      _log.push(d.name);
    }
  `, ctx);
  vm.runInContext(REGION1, ctx);
  vm.runInContext(REGION2, ctx);
  env.ctx = ctx;
  env.run = (code) => vm.runInContext(code, ctx);
  env.push = (name, steps, stepMs, epoch) => env.run(
    `osmReadyPush([{ tx: 0, tz: 0 }], ${epoch === undefined ? 'osmEpoch' : epoch}, function* () { yield* processTileDataSteps({ name: '${name}', steps: ${steps}, stepMs: ${stepMs} }); })`);
  env.tick = () => { const t0 = env.clock; env.timers.shift()(); return env.clock - t0; }; // 1回分のタイマーを動かし、使った時間(ms)を返す
  env.runAll = (limit = 10000) => { const d = []; while (env.timers.length && d.length < limit) d.push(env.tick()); return d; };
  env.log = () => env.run('_log.join(",")');
  return env;
}

test('スライス実行: 6msごとに切れ、全部終わってから新規取得(processOSMTileQueue)を再開する', () => {
  const env = makeEnv();
  env.push('A', 100, 1);
  const d = env.runAll();
  assert.strictEqual(env.log(), 'A');
  assert.strictEqual(d.length, 17);                 // 100ms ÷ 6ms
  assert.ok(Math.max(...d) <= 6, 'max ' + Math.max(...d));
  assert.strictEqual(env.queueCalls, 1);            // 処理中は呼ばず、終わった時に1回
  assert.strictEqual(env.run('_osmJob'), null);
});

test('?slice=0・裏タブでは中断せず1回で最後まで進める', () => {
  for (const opt of [{ search: '?slice=0' }, { hidden: true }]) {
    const env = makeEnv(opt);
    env.push('A', 100, 1);
    assert.deepStrictEqual(env.runAll(), [100]);
    assert.strictEqual(env.log(), 'A');
  }
});

test('起動直後(30秒以内)と現在地タイル待ちは12ms、ジャンプ後の古い分は24ms', () => {
  const env = makeEnv();
  env.clock = 5000; // 起動直後
  env.push('A', 60, 1);
  assert.ok(Math.max(...env.runAll()) <= 12);
  const env2 = makeEnv();
  env2.run('_curTileRush = true');
  env2.push('A', 60, 1);
  assert.ok(Math.max(...env2.runAll()) <= 12);
  const env3 = makeEnv();
  env3.push('A', 200, 1);
  env3.tick();                                      // 1スライス進めてから
  env3.run('osmEpoch = 2');                         // ジャンプ
  const d = env3.runAll();
  assert.ok(Math.max(...d) <= 24 && Math.max(...d) > 12, 'max ' + Math.max(...d));
  assert.strictEqual(env3.log(), 'A');              // 処理中の分は捨てずに最後まで進める
});

test('ジャンプ前の世代の未着手バッチは捨てる', () => {
  const env = makeEnv();
  env.run('osmEpoch = 2');
  env.push('OLD', 10, 1, 1);
  env.runAll();
  assert.strictEqual(env.log(), '');
});

test('同期呼び出し(processTileData)は、途中の分を先に終わらせてから自分を処理する', () => {
  const env = makeEnv();
  env.push('A', 100, 1);
  env.tick();                                       // Aは途中
  assert.strictEqual(env.log(), '');
  env.run("processTileData({ name: 'B', steps: 3, stepMs: 1 })");
  assert.strictEqual(env.log(), 'A,B');
  assert.strictEqual(env.run('_osmJob'), null);
  env.runAll();                                     // 残りのタイマーが空振りしても壊れない
  assert.strictEqual(env.log(), 'A,B');
});

test('途中で例外が出ても、そのバッチだけ捨てて次へ進む', () => {
  const env = makeEnv();
  env.run("osmReadyPush([{ tx: 0, tz: 0 }], osmEpoch, function* () { yield; throw new Error('boom'); })");
  env.push('C', 10, 1);
  env.runAll();
  assert.strictEqual(env.errors.length, 1);
  assert.strictEqual(env.log(), 'C');
});

test('_tdBreak: 中断中は道路メッシュ・建物削除の溜め先を外し、再開で戻す', () => {
  const env = makeEnv();
  env.run("var __g = _tdBreak({ acc: 0, t: 0, n: 1 }); _roadMeshCollector = ['x']; _roadBuildingRemoveBatch = new Set(['b']); __g.next();");
  assert.strictEqual(env.run('_roadMeshCollector'), null);
  assert.strictEqual(env.run('_roadBuildingRemoveBatch'), null);
  env.run('__g.next()');
  assert.strictEqual(env.run('_roadMeshCollector.length'), 1);
  assert.strictEqual(env.run('_roadBuildingRemoveBatch.has("b")'), true);
});
