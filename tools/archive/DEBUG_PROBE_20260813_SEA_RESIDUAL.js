/* ============================================================================
 * ChronoDrift 実測プローブ 2026-08-13 — 残り20.5%の内訳を距離で分ける
 *
 * 直前の結果(coastline chain方式に置換後、NY):
 *   海面以下61.4% / +0〜1 8.6% / +1〜3 9.5% / +3〜10 12.7% / +10〜30 5.9% / +30超 1.9%
 *   → 合計「+3以上」= 20.5%(置換前は35.6%)。目標10%未満には未達。
 *
 * 知りたいこと:
 *   残っている誤判定は「海岸線から遠い点」に偏っているか、それとも距離に関係なく散るか。
 *     偏る   → COAST_DECIDE_MAX を下げれば切れる。パラメータ1つで済む
 *     散らばる→ 判定そのものの問題。別の対策が要る
 *
 * ゲーム本体は一切変更しない。NYで90秒待ってから貼る。
 * ========================================================================== */
window.__cdResidual = function () {
  const seaTop = seaLevelY() + seaYOffset();
  // 実装済みの coastlineSegs をそのまま使う(無ければストアから組み立てる)
  let segs = (typeof coastlineSegs !== 'undefined' && coastlineSegs) ? coastlineSegs : null;
  if (!segs) {
    const ways = [];
    for (const w of coastlineWayStore.values()) if (w && w.pts && w.pts.length >= 2) ways.push(w.pts);
    segs = [];
    for (const c of ways) for (let i = 0; i < c.length - 1; i++) {
      const a = c[i], b = c[i + 1];
      segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z });
    }
    console.warn('coastlineSegs が無いのでストアから組み立てました(seg=' + segs.length + ')');
  }
  const polys = areaPolyMeshes.filter(e => e.kind === 'flat' && e.fixedY != null);
  if (!polys.length) { console.warn('海面ポリゴンが0件'); return; }
  console.log('%c=== 残差の内訳(距離 × 地形の超過) ===', 'font-weight:bold;color:#06c');
  console.log('海面ポリゴン=' + polys.length + ' / coastline区間=' + segs.length +
    ' / 海面Y=' + seaTop.toFixed(2));

  function nearDist(px, pz) {
    let best = Infinity;
    for (const s of segs) {
      const dx = s.bx - s.ax, dz = s.bz - s.az, len2 = dx * dx + dz * dz;
      let t = len2 > 0 ? ((px - s.ax) * dx + (pz - s.az) * dz) / len2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const cx = s.ax + dx * t, cz = s.az + dz * t;
      const d = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  const STEP = 100, seen = new Set(), pts = [];
  for (const e of polys) {
    for (let z = Math.ceil(e.minZ / STEP) * STEP; z <= e.maxZ; z += STEP)
      for (let x = Math.ceil(e.minX / STEP) * STEP; x <= e.maxX; x += STEP) {
        const k = x + ',' + z;
        if (seen.has(k) || !pointInPolygon(x, z, e.pts)) continue;
        seen.add(k);
        const t = terrainYOrNull(x, z);
        if (t === null || t === undefined) continue;
        pts.push({ x, z, e: t - seaTop, d: nearDist(x, z) });
      }
  }
  console.log('サンプル点=' + pts.length);

  // --- クロス集計: 距離 × 超過 ---------------------------------------------
  const DB = [0, 100, 300, 600, 1000, 1500, 2000, 3000, Infinity];
  const eLab = p => p.e <= 0 ? '海面以下' : p.e <= 3 ? '+0〜3' : p.e <= 10 ? '+3〜10' :
                    p.e <= 30 ? '+10〜30' : '+30超';
  const cols = ['海面以下', '+0〜3', '+3〜10', '+10〜30', '+30超'];
  const table = [];
  for (let i = 0; i < DB.length - 1; i++) {
    const lo = DB[i], hi = DB[i + 1];
    const sub = pts.filter(p => p.d >= lo && p.d < hi);
    if (!sub.length) continue;
    const row = { '最近傍まで': (hi === Infinity ? lo + 'm〜' : lo + '〜' + hi + 'm'), 点数: sub.length };
    for (const c of cols) row[c] = sub.filter(p => eLab(p) === c).length;
    row['+3以上の割合'] = (100 * sub.filter(p => p.e > 3).length / sub.length).toFixed(0) + '%';
    table.push(row);
  }
  console.table(table);
  console.log('※ 下の行(遠距離)ほど「+3以上の割合」が高いなら、距離のしきい値で切れる。');

  // --- しきい値ごとの損得 ---------------------------------------------------
  // 「その距離より遠い点を海面から外す」と、誤り(+3以上)がいくつ消え、
  // 正しい海(海面以下)がいくつ巻き添えで消えるか。
  const bad = pts.filter(p => p.e > 3), good = pts.filter(p => p.e <= 0);
  console.log('%c-- 距離しきい値の損得(その距離より遠い点を塗らない場合) --', 'font-weight:bold;color:#06c');
  console.table([500, 800, 1000, 1200, 1500, 2000, 2500, 3000].map(T => {
    const bCut = bad.filter(p => p.d > T).length, gCut = good.filter(p => p.d > T).length;
    return { しきい値m: T,
      '消える誤り(良)': bCut + ' / ' + bad.length + ' (' + (100 * bCut / bad.length).toFixed(0) + '%)',
      '巻き添えの海(悪)': gCut + ' / ' + good.length + ' (' + (100 * gCut / good.length).toFixed(0) + '%)',
      '残る+3以上の全体比': (100 * (bad.length - bCut) / pts.length).toFixed(1) + '%' };
  }));

  // --- 近距離(300m未満)なのに超過が大きい点 = 別原因 ----------------------
  const nearBad = bad.filter(p => p.d < 300).sort((a, b) => b.e - a.e);
  console.log('%c-- 岸から300m未満なのに地形が+3以上(距離では説明できない誤り) --', 'font-weight:bold;color:#06c');
  console.log('件数=' + nearBad.length + ' / +3以上の全体 ' + bad.length + '件中 ' +
    (100 * nearBad.length / Math.max(1, bad.length)).toFixed(0) + '%');
  const picked = [];
  for (const p of nearBad) {
    if (picked.some(q => Math.hypot(q.x - p.x, q.z - p.z) < 400)) continue;
    const c = xzToLatLon(p.x, p.z);
    picked.push(Object.assign({}, p, { gmaps: 'https://www.google.com/maps?q=' + c.lat.toFixed(5) + ',' + c.lon.toFixed(5) }));
    if (picked.length >= 12) break;
  }
  console.table(picked.map(p => ({ 超過: +p.e.toFixed(1), 最近傍m: Math.round(p.d), gmaps: p.gmaps })));
  console.log('%c=== console右クリック→Save as... で保存して共有してください ===', 'font-weight:bold;color:#06c');
  return { pts, bad, good };
};
console.log('%c[probe] __cdResidual() を実行してください。', 'color:#0a0;font-weight:bold');
