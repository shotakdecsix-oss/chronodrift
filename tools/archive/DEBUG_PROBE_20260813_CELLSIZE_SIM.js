/* ============================================================================
 * ChronoDrift 実測プローブ 2026-08-13 — セル一辺を変えた結果を「デプロイせずに」予測する
 *
 * COAST_CELL_M を 100 → 50 にすると残差がどう変わるかを、コンソール上で先に計算する。
 * 実際に動いている isSeaPoint / coastlineSegs / coastlineRings をそのまま使うので、
 * 判定ロジックは本番と完全に同一。変わるのはセルの刻みだけ。
 *
 * 使い方: NYで90秒待ってから全文を貼る。__cdCellSim() が自動実行される。
 * ゲーム本体は一切変更しない。数秒かかる。
 * ========================================================================== */
window.__cdCellSim = function (sizes, tileRange) {
  sizes = sizes || [100, 50];
  tileRange = tileRange || 2;              // プレイヤー中心の (2*n+1)^2 タイルを評価
  const seaTop = seaLevelY() + seaYOffset();
  const segsAll = (typeof coastlineSegs !== 'undefined' && coastlineSegs) ? coastlineSegs : null;
  if (!segsAll) { console.warn('coastlineSegs が見つかりません(新実装が入っていない?)'); return; }
  const rings = (typeof coastlineRings !== 'undefined' && coastlineRings) ? coastlineRings : [];
  const useReal = (typeof isSeaPoint === 'function');
  console.log('%c=== セル一辺のシミュレーション ===', 'font-weight:bold;color:#06c');
  console.log('coastline区間=' + segsAll.length + ' / rings=' + rings.length +
    ' / 判定関数=' + (useReal ? '本番の isSeaPoint' : 'プローブ内の同等実装') +
    ' / 海面Y=' + seaTop.toFixed(2));

  // 本番と同じ判定(isSeaPoint が無い場合の同等実装)
  function seaAt(px, pz, segs) {
    if (useReal) return isSeaPoint(px, pz, segs);
    for (const r of rings) if (pointInPolygon(px, pz, r)) return false;
    let best = Infinity, dot = 0;
    for (const s of segs) {
      const dx = s.bx - s.ax, dz = s.bz - s.az, len2 = dx * dx + dz * dz;
      let t = len2 > 0 ? ((px - s.ax) * dx + (pz - s.az) * dz) / len2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const cx = s.ax + dx * t, cz = s.az + dz * t;
      const d = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
      if (d < best) { best = d; dot = (px - cx) * (-dz) + (pz - cz) * dx; }
    }
    if (best === Infinity) return false;
    return dot >= 0;
  }
  function nearDist(px, pz, segs) {
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

  const T = OSM_TILE_M;
  const ptx = Math.floor(player.position.x / T), ptz = Math.floor(player.position.z / T);
  const tiles = [];
  for (let dz = -tileRange; dz <= tileRange; dz++)
    for (let dx = -tileRange; dx <= tileRange; dx++) tiles.push({ tx: ptx + dx, tz: ptz + dz });
  console.log('評価タイル=' + tiles.length + '枚(プレイヤー中心 ' + (2 * tileRange + 1) + '×' + (2 * tileRange + 1) + ')');

  const GUARD = 3000;
  const rows = [], detail = {};
  for (const CELL of sizes) {
    let seaCells = 0, e3 = 0, far300bad = 0, far600bad = 0, near100 = 0, near100bad = 0, skipped = 0;
    for (const t of tiles) {
      const x0 = t.tx * T, x1 = x0 + T, z0 = t.tz * T, z1 = z0 + T;
      const segs = segsAll.filter(s =>
        s.minX <= x1 + GUARD && s.maxX >= x0 - GUARD && s.minZ <= z1 + GUARD && s.maxZ >= z0 - GUARD);
      if (!segs.length) { skipped++; continue; }
      const N = Math.round(T / CELL);
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const cx = x0 + (i + 0.5) * CELL, cz = z0 + (j + 0.5) * CELL;
          if (!seaAt(cx, cz, segs)) continue;
          seaCells++;
          const ter = terrainYOrNull(cx, cz);
          if (ter === null || ter === undefined) continue;
          const ex = ter - seaTop;
          const d = nearDist(cx, cz, segs);
          if (d < 100) { near100++; if (ex > 3) near100bad++; }
          if (ex > 3) {
            e3++;
            if (d >= 300) far300bad++;
            if (d >= 600) far600bad++;
          }
        }
    }
    const areaKm2 = seaCells * CELL * CELL / 1e6;
    rows.push({
      'セル一辺m': CELL,
      '海セル数': seaCells,
      '海の面積km2': +areaKm2.toFixed(2),
      '超過+3以上': e3 + ' (' + (100 * e3 / Math.max(1, seaCells)).toFixed(1) + '%)',
      '岸100m未満の誤り率': (100 * near100bad / Math.max(1, near100)).toFixed(0) + '%',
      '岸300m以上の誤り': far300bad + ' (' + (100 * far300bad / Math.max(1, seaCells)).toFixed(2) + '%)',
      '岸600m以上の誤り': far600bad + ' (' + (100 * far600bad / Math.max(1, seaCells)).toFixed(2) + '%)'
    });
    detail[CELL] = { seaCells, e3, far300bad, far600bad, near100, near100bad, skipped };
  }
  console.table(rows);
  console.log('%c読み方', 'font-weight:bold;color:#06c');
  console.log('・「海の面積km2」がセルを細かくしてもほぼ同じ → 塗る範囲は変わっていない(健全)');
  console.log('・「岸100m未満の誤り率」が下がる → 残差は分解能由来だったと確定。50mへ変更する価値あり');
  console.log('・「岸300m以上の誤り」がほぼ動かない → 判定ロジック自体は正しい(これが本命の指標)');
  console.log('・面積が大きく減る → セルを細かくすると海が塗られなくなっている。要注意');
  console.log('%c=== console右クリック→Save as... で保存して共有してください ===', 'font-weight:bold;color:#06c');
  return { rows, detail };
};
console.log('%c[probe] __cdCellSim() を実行してください(数秒かかります)。', 'color:#0a0;font-weight:bold');
