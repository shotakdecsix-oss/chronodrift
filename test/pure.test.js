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
