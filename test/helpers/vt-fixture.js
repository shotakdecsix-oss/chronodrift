'use strict';
// テスト用の合成ベクタータイル(MVT)と、タイルを返すfetchの代役。ネットワークなしで vt.js の変換経路を通すため。
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const zz = (v) => (v << 1) ^ (v >> 31);
const ld = (field, bytes) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
const vi = (field, n) => [...varint(field * 8), ...varint(n)];
const str = (s) => [...Buffer.from(s, 'utf8')];
function feature(type, tags, cmds) { return [...ld(2, tags.flatMap(varint)), ...vi(3, type), ...ld(4, cmds.flatMap(varint))]; }
function layer(name, feats, keys, vals) {
  let b = [...vi(15, 2), ...ld(1, str(name))];
  for (const f of feats) b = b.concat(ld(2, f));
  for (const k of keys) b = b.concat(ld(3, str(k)));
  for (const v of vals) b = b.concat(ld(4, typeof v === 'string' ? ld(1, str(v)) : vi(5, v)));
  return ld(3, b.concat(vi(5, 4096)));
}
const ring = (x, y, w) => { // 外周(MVTの外周は面積が正になる向き)。MoveTo→LineTo×3→ClosePath
  const pts = [[x, y], [x + w, y], [x + w, y + w], [x, y + w]];
  const c = [9, zz(pts[0][0]), zz(pts[0][1]), (3 << 3) | 2];
  for (let i = 1; i < 4; i++) c.push(zz(pts[i][0] - pts[i - 1][0]), zz(pts[i][1] - pts[i - 1][1]));
  c.push(15);
  return c;
};
// 建物 nx×ny 棟(1棟あたりの座標は閉じて5点 → 1通あたり数百棟で分割される大きさ)、東の境界をまたぐ橋の道路1本
function tileBytes(nx = 60, ny = 50) {
  const bld = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) bld.push(feature(3, [0, (i + j) % 3], ring(i * 64, j * 64, 40)));
  const road = [feature(2, [0, 0, 1, 1], [9, zz(100), zz(100), (1 << 3) | 2, zz(4000), zz(500)])];
  const bytes = [
    ...layer('building', bld, ['render_height'], [9, 24, 60]),
    ...layer('transportation', road, ['class', 'brunnel'], ['primary', 'bridge']),
  ];
  return Buffer.from(bytes);
}
// opts.badX: そのx列のタイルは500を返す
function makeFetch(opts = {}) {
  const tile = tileBytes();
  const ab = tile.buffer.slice(tile.byteOffset, tile.byteOffset + tile.byteLength);
  return async (url) => {
    const u = String(url);
    if (u.includes('openfreemap.org/planet')) return { status: 200, ok: true, json: async () => ({ tiles: ['https://tiles.test/{z}/{x}/{y}.pbf'] }) };
    const m = /\/14\/(\d+)\/(\d+)\.pbf$/.exec(u);
    if (m && opts.badX !== undefined && Number(m[1]) === opts.badX) return { status: 500, ok: false };
    return { status: 200, ok: true, arrayBuffer: async () => ab.slice(0) };
  };
}
module.exports = { tileBytes, makeFetch };
