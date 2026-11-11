// js/lib/pure.js(ブラウザ用のグローバル関数群)を vm に読み込んで検査する
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'lib', 'pure.js'), 'utf8');
const ctx = vm.createContext({ Math, console });
vm.runInContext(src, ctx);

test('pointInPolygon: 正方形の内外', () => {
  const sq = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
  assert.strictEqual(ctx.pointInPolygon(5, 5, sq), true);
  assert.strictEqual(ctx.pointInPolygon(15, 5, sq), false);
  assert.strictEqual(ctx.pointInPolygon(-1, -1, sq), false);
});

test('pointInPolygon: L字の凹部は外', () => {
  const l = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 4 }, { x: 4, z: 4 }, { x: 4, z: 10 }, { x: 0, z: 10 }];
  assert.strictEqual(ctx.pointInPolygon(2, 8, l), true);
  assert.strictEqual(ctx.pointInPolygon(8, 8, l), false);
});

test('distSqPointToSeg: 垂線・端点クランプ・長さ0の線分', () => {
  assert.strictEqual(ctx.distSqPointToSeg(5, 3, 0, 0, 10, 0), 9);
  assert.strictEqual(ctx.distSqPointToSeg(-3, 4, 0, 0, 10, 0), 25);
  assert.strictEqual(ctx.distSqPointToSeg(1, 1, 2, 2, 2, 2), 2);
});

test('shadeHex: 係数で明暗、255で頭打ち', () => {
  assert.strictEqual(ctx.shadeHex(0x808080, 0.5), 0x404040);
  assert.strictEqual(ctx.shadeHex(0xc0c0c0, 2), 0xffffff);
});

test('pickWeighted: 乱数を渡すと決定的に選ぶ', () => {
  const w = { a: 1, b: 1, c: 2 };
  assert.strictEqual(ctx.pickWeighted(w, () => 0.0), 'a');
  assert.strictEqual(ctx.pickWeighted(w, () => 0.3), 'b');
  assert.strictEqual(ctx.pickWeighted(w, () => 0.9), 'c');
  assert.strictEqual(ctx.pickWeighted({}, () => 0.5), null);
});

test('parseOsmColor: #rrggbb / #rgb / 空', () => {
  assert.strictEqual(ctx.parseOsmColor('#ff8800'), 0xff8800);
  assert.strictEqual(ctx.parseOsmColor('#f80'), 0xff8800);
  assert.strictEqual(ctx.parseOsmColor(''), null);
});

test('reviveBudget: 新方式は待ち行列200件以上で0、未満は min(600, max(5, 空き+解放))', () => {
  assert.strictEqual(ctx.reviveBudget(1000, 50, 200, false), 0);
  assert.strictEqual(ctx.reviveBudget(1000, 50, 5000, false), 0);
  assert.strictEqual(ctx.reviveBudget(1000, 50, 199, false), 600); // 上限600
  assert.strictEqual(ctx.reviveBudget(100, 20, 0, false), 120);
  assert.strictEqual(ctx.reviveBudget(0, 0, 0, false), 5); // 下限(旧30/1.5秒≒5/250ms)
});

test('reviveBudget: ?revive=old は従来式(待ち行列を見ない・下限30)', () => {
  assert.strictEqual(ctx.reviveBudget(0, 0, 99999, true), 30);
  assert.strictEqual(ctx.reviveBudget(1000, 50, 99999, true), 600);
  assert.strictEqual(ctx.reviveBudget(100, 20, 0, true), 120);
});

test('idxPush / idxSwapRemove: O(1)で外し、詰めた要素の番号も更新する', () => {
  const list = [], a = {}, b = {}, c = {}, d = {};
  [a, b, c, d].forEach(o => ctx.idxPush(list, o));
  assert.deepStrictEqual([a._hi, b._hi, c._hi, d._hi], [0, 1, 2, 3]);
  assert.strictEqual(ctx.idxSwapRemove(list, b), true); // 途中を外す → 末尾のdがbの位置へ
  assert.strictEqual(list.length, 3);
  assert.strictEqual(list[1], d);
  assert.strictEqual(d._hi, 1);
  assert.strictEqual(b._hi, -1);
  assert.strictEqual(ctx.idxSwapRemove(list, b), false); // 二重に外してもfalse(何も壊さない)
  assert.strictEqual(ctx.idxSwapRemove(list, d), true);
  assert.strictEqual(ctx.idxSwapRemove(list, c), true); // 末尾を外す
  assert.strictEqual(ctx.idxSwapRemove(list, a), true); // 最後の1個
  assert.strictEqual(list.length, 0);
  assert.strictEqual(ctx.idxSwapRemove(list, {}), false); // 未追加(_hi無し)
});
