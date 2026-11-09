/* ============================================================================
 * ChronoDrift 実測プローブ 2026-08-13 v3 — 接線の平滑化で狭い水路が直るか
 *
 * v2の結果: 18点中15点一致。陸9件は9/9。外れた3件はすべて「水」で、
 *   ・ナローズ(最近傍4093m)      = その辺の海岸線が未取得。アルゴリズムの問題ではない
 *   ・ニュータウンクリーク河口     = 幅100m級の狭い水路
 *   ・キルヴァンカル               = 幅500m級の狭い海峡
 *   海面ポリゴン内の29.8%が新判定で陸(地形ベース推定35.6%とほぼ一致)。
 *
 * v3の仮説: 狭い水路で外れるのは、最近傍の線分が桟橋・護岸の小さな突起で、
 *   その1本の向きだけで海側を決めているから。chain上を前後に一定距離たどった
 *   **平滑化した接線**を使えば局所ノイズが消えるはず。
 *
 * 平滑化距離を 0(=v2と同じ) / 50 / 150 / 400m の4通りで比較する。
 * ゲーム本体は一切変更しない。
 * ========================================================================== */
window.__cdRings3 = function () {
  const store = (typeof coastlineWayStore !== 'undefined') ? coastlineWayStore : null;
  if (!store || !store.size) { console.warn('coastlineWayStore が見つかりません'); return; }

  // --- 1) chain 組み立て(v1/v2と同じ) -------------------------------------
  const ways = [];
  for (const w of store.values()) if (w && w.pts && w.pts.length >= 2) ways.push(w.pts);
  const EPS = 1.0, key = p => Math.round(p.x / EPS) + '|' + Math.round(p.z / EPS);
  const ends = new Map();
  ways.forEach((pts, i) => { for (const p of [pts[0], pts[pts.length - 1]]) {
    const k = key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); } });
  const usedWay = new Array(ways.length).fill(false), chains = [];
  const takeNext = p => { for (const i of (ends.get(key(p)) || [])) if (!usedWay[i]) return i; return -1; };
  for (let s = 0; s < ways.length; s++) {
    if (usedWay[s]) continue;
    usedWay[s] = true;
    let c = ways[s].slice();
    for (;;) { const i = takeNext(c[c.length - 1]); if (i < 0) break; usedWay[i] = true;
      const w = ways[i]; c = c.concat(key(w[0]) === key(c[c.length - 1]) ? w.slice(1) : w.slice(0, -1).reverse()); }
    for (;;) { const i = takeNext(c[0]); if (i < 0) break; usedWay[i] = true;
      const w = ways[i]; c = (key(w[w.length - 1]) === key(c[0]) ? w.slice(0, -1) : w.slice(1).reverse()).concat(c); }
    chains.push(c);
  }
  const isClosed = c => Math.hypot(c[0].x - c[c.length-1].x, c[0].z - c[c.length-1].z) <= EPS * 2;
  const rings = chains.filter(isClosed);
  console.log('%c=== 接線の平滑化の効果 (v3) ===', 'font-weight:bold;color:#06c');
  console.log('way=' + ways.length + ' / chain=' + chains.length + ' (閉じた=' + rings.length + ')');

  // --- 2) 最近傍点(1回だけ求める) -----------------------------------------
  function nearest(px, pz) {
    let best = Infinity, r = null;
    for (const c of chains) {
      for (let i = 0; i < c.length - 1; i++) {
        const a = c[i], b = c[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
        let t = len2 > 0 ? ((px - a.x) * dx + (pz - a.z) * dz) / len2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const cx = a.x + dx * t, cz = a.z + dz * t;
        const d = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
        if (d < best) { best = d; r = { c, i, t, cx, cz, d: Math.sqrt(d) }; }
      }
    }
    return r;
  }
  // chain上を span だけ辿った点を返す(dir=+1 前 / -1 後ろ)
  function walk(c, si, t, span, dir) {
    let i = si;
    let px = c[i].x + (c[i + 1].x - c[i].x) * t;
    let pz = c[i].z + (c[i + 1].z - c[i].z) * t;
    let rem = span;
    if (dir > 0) {
      while (rem > 0 && i < c.length - 1) {
        const bx = c[i + 1].x, bz = c[i + 1].z, seg = Math.hypot(bx - px, bz - pz);
        if (seg >= rem) { const k = rem / seg; return { x: px + (bx - px) * k, z: pz + (bz - pz) * k }; }
        rem -= seg; px = bx; pz = bz; i++;
      }
    } else {
      while (rem > 0 && i >= 0) {
        const ax = c[i].x, az = c[i].z, seg = Math.hypot(px - ax, pz - az);
        if (seg >= rem) { const k = rem / seg; return { x: px + (ax - px) * k, z: pz + (az - pz) * k }; }
        rem -= seg; px = ax; pz = az; i--;
      }
    }
    return { x: px, z: pz };
  }
  // 平滑化距離 span で「陸か」を判定する。span=0 は v2 と同じ(線分1本)
  function isLand(px, pz, near, span) {
    let dx, dz;
    if (span <= 0) {
      const a = near.c[near.i], b = near.c[near.i + 1];
      dx = b.x - a.x; dz = b.z - a.z;
    } else {
      const f = walk(near.c, near.i, near.t, span, +1);
      const bk = walk(near.c, near.i, near.t, span, -1);
      dx = f.x - bk.x; dz = f.z - bk.z;
      if (dx * dx + dz * dz < 1) { const a = near.c[near.i], b = near.c[near.i + 1]; dx = b.x - a.x; dz = b.z - a.z; }
    }
    const seaX = -dz, seaZ = dx;                       // 海側ベクトル(進行方向の右手)
    return (px - near.cx) * seaX + (pz - near.cz) * seaZ < 0;
  }
  const SPANS = [0, 50, 150, 400];
  function classifyAll(px, pz) {
    for (const r of rings) if (pointInPolygon(px, pz, r)) return { dist: 0, verdicts: SPANS.map(() => true) };
    const near = nearest(px, pz);
    if (!near) return { dist: Infinity, verdicts: SPANS.map(() => false) };
    return { dist: near.d, verdicts: SPANS.map(s => isLand(px, pz, near, s)) };
  }

  // --- 3) 既知18点で比較 -----------------------------------------------------
  const TESTS = [
    ['タイムズスクエア',          40.7580, -73.9855, '陸'],
    ['セントラルパーク',          40.7812, -73.9665, '陸'],
    ['ウォール街',                40.7061, -74.0087, '陸'],
    ['ロングアイランドシティ',    40.7447, -73.9485, '陸'],
    ['プロスペクトパーク(BK)',    40.6602, -73.9690, '陸'],
    ['ジャージーシティ市街',      40.7178, -74.0431, '陸'],
    ['ホーボーケン',              40.7440, -74.0324, '陸'],
    ['スタテン島 St.George',      40.6437, -74.0736, '陸'],
    ['ガバナーズ島',              40.6895, -74.0165, '陸'],
    ['ハドソン川(中央)',         40.7100, -74.0200, '水'],
    ['ハドソン川(北・中央)',     40.7500, -74.0100, '水'],
    ['イーストリバー(中央)',     40.7050, -73.9950, '水'],
    ['ニュータウンクリーク河口',  40.7370, -73.9610, '水'],
    ['バタリー沖',                40.6950, -74.0180, '水'],
    ['アッパー湾',                40.6700, -74.0500, '水'],
    ['ゴワヌス湾',                40.6640, -74.0180, '水'],
    ['ナローズ',                  40.6060, -74.0450, '水'],
    ['キルヴァンカル',            40.6450, -74.0850, '水']
  ];
  const rows = [], score = SPANS.map(() => 0);
  for (const [name, lat, lon, expect] of TESTS) {
    const p = latLonToXZ(lat, lon), r = classifyAll(p.x, p.z);
    const row = { 地点: name, 期待: expect, 最近傍m: r.dist === Infinity ? '∞' : Math.round(r.dist) };
    SPANS.forEach((s, k) => {
      const j = r.verdicts[k] ? '陸' : '水';
      row['平滑' + s] = j + (j === expect ? '' : ' ×');
      if (j === expect) score[k]++;
    });
    rows.push(row);
  }
  console.table(rows);
  console.log('%c正解数: ' + SPANS.map((s, k) => '平滑' + s + 'm→' + score[k] + '/' + TESTS.length).join('  /  '),
    'font-weight:bold;font-size:14px');
  console.log('※ ナローズは最近傍4093m(海岸線未取得)なので、どの平滑値でも直らないのが正常。');

  // --- 4) 海面ポリゴン内での「新判定=陸」の割合を平滑値ごとに ----------------
  const seaPolys = areaPolyMeshes.filter(e => e.kind === 'flat' && e.fixedY != null);
  const seen = new Set(); let inSea = 0; const land = SPANS.map(() => 0);
  for (const e of seaPolys) {
    for (let z = Math.ceil(e.minZ / 200) * 200; z <= e.maxZ; z += 200)
      for (let x = Math.ceil(e.minX / 200) * 200; x <= e.maxX; x += 200) {
        const k = x + ',' + z;
        if (seen.has(k) || !pointInPolygon(x, z, e.pts)) continue;
        seen.add(k); inSea++;
        const r = classifyAll(x, z);
        r.verdicts.forEach((v, i) => { if (v) land[i]++; });
      }
  }
  console.log('%c-- 海面ポリゴン内サンプル ' + inSea + '点のうち「陸」と判定される割合 --', 'font-weight:bold;color:#06c');
  console.table(SPANS.map((s, k) => ({ 平滑距離m: s, 陸判定: land[k],
    割合: (100 * land[k] / Math.max(1, inSea)).toFixed(1) + '%' })));
  console.log('※ 地形ベースの独立推定は35.6%。近い値のまま安定していれば平滑化の副作用は無い。');
  console.log('%c=== console右クリック→Save as... で保存して共有してください ===', 'font-weight:bold;color:#06c');
  return { chains, rings, rows, score, inSea, land };
};
console.log('%c[probe] __cdRings3() を実行してください。', 'color:#0a0;font-weight:bold');
