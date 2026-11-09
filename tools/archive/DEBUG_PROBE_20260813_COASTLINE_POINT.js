/* ============================================================================
 * ChronoDrift 実測プローブ 2026-08-13 — 誤判定した1点を解剖する
 *
 * 対象: 40.7370, -73.9610(イーストリバー、ニュータウンクリーク河口沖)
 *       実際は「水」だが、最近傍区間の海側/陸側判定は「陸」と答える。
 *       接線の平滑化(0/50/150/400m)を全部試しても微動だにしなかった。
 *
 * 使い方: NYで90秒待ってから全文を貼る。既定の1点で自動実行される。
 *         別の点を見たいときは __cdPoint(lat, lon)
 *
 * ゲーム本体は一切変更しない。
 * ========================================================================== */
window.__cdPoint = function (lat, lon, topN) {
  lat = (lat == null) ? 40.7370 : lat;
  lon = (lon == null) ? -73.9610 : lon;
  topN = topN || 8;
  const store = (typeof coastlineWayStore !== 'undefined') ? coastlineWayStore : null;
  if (!store || !store.size) { console.warn('coastlineWayStore が見つかりません'); return; }

  // --- chain 組み立て(これまでと同じ) --------------------------------------
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
  const P = latLonToXZ(lat, lon);
  const ll = (x, z) => { const c = xzToLatLon(x, z); return c.lat.toFixed(5) + ',' + c.lon.toFixed(5); };
  const gm = (x, z) => 'https://www.google.com/maps?q=' + ll(x, z);
  console.log('%c=== 1点の解剖: ' + lat + ', ' + lon + ' ===', 'font-weight:bold;color:#06c');
  console.log('chain数=' + chains.length + ' / この点 ' + gm(P.x, P.z));

  // --- 1) 最近傍の上位N区間を全部出す ---------------------------------------
  const cand = [];
  chains.forEach((c, ci) => {
    for (let i = 0; i < c.length - 1; i++) {
      const a = c[i], b = c[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
      let t = len2 > 0 ? ((P.x - a.x) * dx + (P.z - a.z) * dz) / len2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const cx = a.x + dx * t, cz = a.z + dz * t;
      const d = Math.hypot(P.x - cx, P.z - cz);
      // 海側ベクトル(進行方向の右手)= (-dz, dx)
      const dot = (P.x - cx) * (-dz) + (P.z - cz) * dx;
      cand.push({ ci, i, t, d, cx, cz, ax: a.x, az: a.z, bx: b.x, bz: b.z, dot,
        chainLen: c.length });
    }
  });
  cand.sort((a, b) => a.d - b.d);
  const rows = cand.slice(0, topN).map((s, k) => ({
    順位: k + 1,
    距離m: +s.d.toFixed(1),
    判定: s.dot < 0 ? '陸' : '水',
    頂点上か: (s.t <= 1e-6 || s.t >= 1 - 1e-6) ? 'YES(角)' : '',
    区間長m: +Math.hypot(s.bx - s.ax, s.bz - s.az).toFixed(1),
    chain: s.ci + '(' + s.chainLen + '点)',
    区間始: ll(s.ax, s.az),
    区間終: ll(s.bx, s.bz),
    最近傍点: gm(s.cx, s.cz)
  }));
  console.log('%c-- 最近傍 上位' + topN + '区間(それぞれ単独で判定させた結果) --', 'font-weight:bold;color:#06c');
  console.table(rows);
  const landN = cand.slice(0, topN).filter(s => s.dot < 0).length;
  console.log('上位' + topN + '区間の内訳: 陸=' + landN + ' / 水=' + (topN - landN) +
    (landN === topN ? '  → 全区間が一致して「陸」。角の不定ではなく、向きの解釈そのものを疑う' :
     landN === 0 ? '  → 全区間が「水」。最近傍1本の選び方だけの問題' :
     '  → 判定が割れている。最近傍1本に頼るのが不安定な場所'));

  // --- 2) 距離の逆二乗で重み付けした多数決 -----------------------------------
  let wLand = 0, wSea = 0;
  for (const s of cand.slice(0, topN)) {
    const w = 1 / Math.max(1, s.d * s.d);
    if (s.dot < 0) wLand += w; else wSea += w;
  }
  console.log('1/d²重み付き多数決: 陸=' + wLand.toExponential(2) + ' / 水=' + wSea.toExponential(2) +
    ' → ' + (wLand > wSea ? '陸' : '水'));

  // --- 3) 4方向へのレイ交差数(符号つき) ------------------------------------
  // 海岸線は「進行方向の左が陸」で有向。閉じていれば巻き数で内外が決まる。
  // 開いたchainでも、4方向の符号つき交差数が揃うかどうかで一貫性が見える。
  function rayCount(dirX, dirZ) {
    let signed = 0, crossings = 0;
    for (const c of chains) {
      for (let i = 0; i < c.length - 1; i++) {
        const a = c[i], b = c[i + 1];
        // レイを x軸/z軸方向に限定して単純化
        if (dirZ === 0) {
          if ((a.z > P.z) === (b.z > P.z)) continue;
          const t = (P.z - a.z) / (b.z - a.z);
          const ix = a.x + (b.x - a.x) * t;
          if (dirX > 0 ? ix > P.x : ix < P.x) { crossings++; signed += (b.z > a.z) ? 1 : -1; }
        } else {
          if ((a.x > P.x) === (b.x > P.x)) continue;
          const t = (P.x - a.x) / (b.x - a.x);
          const iz = a.z + (b.z - a.z) * t;
          if (dirZ > 0 ? iz > P.z : iz < P.z) { crossings++; signed += (b.x > a.x) ? 1 : -1; }
        }
      }
    }
    return { crossings, signed };
  }
  const dirs = [['東(+x)', 1, 0], ['西(-x)', -1, 0], ['南(+z)', 0, 1], ['北(-z)', 0, -1]];
  console.log('%c-- 4方向レイの交差数 --', 'font-weight:bold;color:#06c');
  console.table(dirs.map(([name, dx, dz]) => {
    const r = rayCount(dx, dz);
    return { 方向: name, 交差数: r.crossings, 偶奇: r.crossings % 2 ? '奇' : '偶', 符号つき合計: r.signed };
  }));
  console.log('※ 4方向で偶奇が揃えば、閉じたリングとして扱える見込みがある。バラバラなら不可。');

  // --- 4) 最近傍chainの周辺の形をそのまま出す --------------------------------
  const best = cand[0];
  const c = chains[best.ci];
  const lo = Math.max(0, best.i - 8), hi = Math.min(c.length - 1, best.i + 9);
  console.log('%c-- 最近傍chainの周辺の頂点(前後8点)。地図で形を確認すること --', 'font-weight:bold;color:#06c');
  console.table(Array.from({ length: hi - lo + 1 }, (_, k) => {
    const i = lo + k, p = c[i];
    return { idx: i, 印: i === best.i ? '← 最近傍区間の始点' : '', 座標: ll(p.x, p.z), gmaps: gm(p.x, p.z) };
  }));
  console.log('%c=== console右クリック→Save as... で保存して共有してください ===', 'font-weight:bold;color:#06c');
  return { cand: cand.slice(0, 50), chains };
};
console.log('%c[probe] __cdPoint() を実行してください(既定は誤判定した1点)。', 'color:#0a0;font-weight:bold');
