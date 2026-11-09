/* ============================================================================
 * ChronoDrift 実測プローブ 2026-08-13 v2 — 陸/海の判定アルゴリズム検証
 *
 * v1の結果:
 *   way 69本 → chain 7本(閉じた2 / 開いた5)。接続は完璧に動いた。
 *   閉じた2つは面積0.69km²と0.06km² = ガバナーズ島とリバティ/エリス島。実物と一致。
 *   ただし本土(マンハッタン・ブルックリン等)は取得範囲の外へ出ていくので閉じない。
 *   → 「閉じたリングの内側=陸」だけでは本土を判定できない(検算5/9、陸4件が全滅)。
 *
 * v2で検証すること:
 *   閉じないchainでも、OSMの規約「進行方向の左が陸・右が海」を
 *   **つなぎ合わせた長いchain上の最近傍点**で適用すれば正しく判定できるか。
 *   (従来のribbonはway単位・両端点だけで海側を決めていたため島の内側を覆っていた)
 *
 * 使い方: NYで90秒待ってから全文を貼る。__cdRings2() が自動実行される。
 * ゲーム本体は一切変更しない。
 * ========================================================================== */
window.__cdRings2 = function (storeName) {
  const store = (function () {
    const names = storeName ? [storeName] : ['coastlineWayStore'];
    for (const n of names) { try { const v = eval(n); if (v && v.size) return v; } catch (e) {} }
    return null;
  })();
  if (!store) { console.warn('coastlineWayStore が見つかりません'); return; }

  // --- 1) way を端点でつないで chain にする(v1と同じ) ----------------------
  const ways = [];
  for (const w of store.values()) if (w && w.pts && w.pts.length >= 2) ways.push(w.pts);
  const EPS = 1.0;
  const key = p => Math.round(p.x / EPS) + '|' + Math.round(p.z / EPS);
  const ends = new Map();
  const addEnd = (p, i) => { const k = key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); };
  ways.forEach((pts, i) => { addEnd(pts[0], i); addEnd(pts[pts.length - 1], i); });
  const usedWay = new Array(ways.length).fill(false);
  const chains = [];
  const takeNext = p => { for (const i of (ends.get(key(p)) || [])) if (!usedWay[i]) return i; return -1; };
  for (let s = 0; s < ways.length; s++) {
    if (usedWay[s]) continue;
    usedWay[s] = true;
    let chain = ways[s].slice();
    for (;;) { const i = takeNext(chain[chain.length - 1]); if (i < 0) break; usedWay[i] = true;
      const w = ways[i]; chain = chain.concat(key(w[0]) === key(chain[chain.length - 1]) ? w.slice(1) : w.slice(0, -1).reverse()); }
    for (;;) { const i = takeNext(chain[0]); if (i < 0) break; usedWay[i] = true;
      const w = ways[i]; chain = (key(w[w.length - 1]) === key(chain[0]) ? w.slice(0, -1) : w.slice(1).reverse()).concat(chain); }
    chains.push(chain);
  }
  const isClosed = pts => Math.hypot(pts[0].x - pts[pts.length-1].x, pts[0].z - pts[pts.length-1].z) <= EPS * 2;
  const closedRings = chains.filter(isClosed);
  console.log('%c=== 陸/海の判定アルゴリズム検証 (v2) ===', 'font-weight:bold;color:#06c');
  console.log('way=' + ways.length + ' / chain=' + chains.length +
    ' (閉じた=' + closedRings.length + ' / 開いた=' + (chains.length - closedRings.length) + ')');

  // --- 2) 判定アルゴリズム ---------------------------------------------------
  // 座標系: xzToLatLon より x=東, z=南。
  // OSM規約「進行方向の左が陸・右が海」。part4.js _crossSide と同じ導出で
  //   海側ベクトル = (-dz, dx)  /  陸側ベクトル = (dz, -dx)
  function classify(px, pz) {
    // (a) 閉じたリング(島)の内側なら無条件で陸
    for (const r of closedRings) if (pointInPolygon(px, pz, r)) return { land: true, dist: 0, why: '島リングの内側' };
    // (b) 全chainの中で最も近い線分を探し、その海側/陸側で決める
    let best = Infinity, bx = 0, bz = 0, bax = 0, baz = 0, bbx = 0, bbz = 0;
    for (const c of chains) {
      for (let i = 0; i < c.length - 1; i++) {
        const a = c[i], b = c[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len2 = dx * dx + dz * dz;
        let t = len2 > 0 ? ((px - a.x) * dx + (pz - a.z) * dz) / len2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const cx = a.x + dx * t, cz = a.z + dz * t;
        const d = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
        if (d < best) { best = d; bx = cx; bz = cz; bax = a.x; baz = a.z; bbx = b.x; bbz = b.z; }
      }
    }
    if (best === Infinity) return { land: false, dist: Infinity, why: 'chainが1本も無い' };
    const dx = bbx - bax, dz = bbz - baz;
    const seaX = -dz, seaZ = dx;                 // 海側ベクトル
    const vx = px - bx, vz = pz - bz;            // 最近傍点から見た向き
    const dot = vx * seaX + vz * seaZ;
    return { land: dot < 0, dist: Math.sqrt(best), why: dot < 0 ? '最近傍区間の陸側' : '最近傍区間の海側' };
  }

  // --- 3) 既知地点で検算 -----------------------------------------------------
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
  const rows = [];
  for (const [name, lat, lon, expect] of TESTS) {
    const p = latLonToXZ(lat, lon);
    const r = classify(p.x, p.z);
    const judged = r.land ? '陸' : '水';
    rows.push({ 地点: name, 期待: expect, 判定: judged,
      一致: judged === expect ? 'OK' : '×',
      最近傍まで_m: r.dist === Infinity ? '∞' : Math.round(r.dist),
      根拠: r.why,
      gmaps: 'https://www.google.com/maps?q=' + lat + ',' + lon });
  }
  console.table(rows);
  const ok = rows.filter(r => r.一致 === 'OK').length;
  console.log('%c一致 ' + ok + '/' + rows.length, 'font-weight:bold;font-size:14px;color:' + (ok === rows.length ? '#0a0' : '#c00'));
  console.log('※「最近傍まで_m」が数km以上の地点は、その辺の海岸線がまだ取得されていない可能性。');

  // --- 4) 現在の海面ポリゴンとの食い違いを数える -----------------------------
  // 「海面ポリゴンの内側なのに、この新判定では陸」= 今まで陸を覆っていた分
  const seaPolys = areaPolyMeshes.filter(e => e.kind === 'flat' && e.fixedY != null);
  let inSea = 0, disagree = 0;
  const seen = new Set(), samples = [];
  for (const e of seaPolys) {
    for (let z = Math.ceil(e.minZ / 200) * 200; z <= e.maxZ; z += 200)
      for (let x = Math.ceil(e.minX / 200) * 200; x <= e.maxX; x += 200) {
        const k = x + ',' + z;
        if (seen.has(k)) continue;
        if (!pointInPolygon(x, z, e.pts)) continue;
        seen.add(k); inSea++;
        if (classify(x, z).land) { disagree++; if (samples.length < 15) samples.push({ x, z }); }
      }
  }
  console.log('%c-- 現在の海面ポリゴンとの突き合わせ --', 'font-weight:bold;color:#06c');
  console.log('海面ポリゴン内のサンプル点=' + inSea +
    ' / 新判定では陸=' + disagree + ' (' + (100 * disagree / Math.max(1, inSea)).toFixed(1) + '%)');
  console.log('※ 前回計測(__cdSea)では「地形が海面より+3以上高い」= 35.6% だった。' +
    'この数字がそれに近ければ、新判定が陸をきちんと除外できている証拠。');
  console.table(samples.map(s => { const c = xzToLatLon(s.x, s.z);
    return { gmaps: 'https://www.google.com/maps?q=' + c.lat.toFixed(5) + ',' + c.lon.toFixed(5) }; }));

  console.log('%c=== console右クリック→Save as... で保存して共有してください ===', 'font-weight:bold;color:#06c');
  return { chains, closedRings, rows, inSea, disagree };
};
console.log('%c[probe] __cdRings2() を実行してください。', 'color:#0a0;font-weight:bold');
