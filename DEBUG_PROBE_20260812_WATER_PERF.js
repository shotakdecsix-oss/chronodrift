/* ============================================================================
 * ChronoDrift 実測プローブ 2026-08-12 (baseline = e98f5a8 / revert commit 7dc2127)
 *
 * 目的: 水面(A: 陸化・浮き上がり)と性能(C)の数値を1回の走行でまとめて取る。
 * 使い方: 本番URLをPC Chromeで開き、DevToolsコンソールにこのファイル全体を貼って実行。
 *         そのあと目的地へジャンプ → 30〜60秒ほど歩く/待つ → __cdReport() を実行。
 *
 * このファイルはコンソールに貼るだけで、ゲーム本体のコードは一切変更しない。
 * デプロイ不要。リロードすれば元に戻る。
 * ========================================================================== */

(function () {
  if (window.__CD_PROBE) { console.log('[probe] 既に導入済みです。__cdReport() を実行してください。'); return; }

  const P = window.__CD_PROBE = {
    t0: Date.now(),
    coastTileLogs: [],   // [coastline] tile ... の生ログ
    coastBatches: [],    // processCoastlineFill の呼び出し1回ぶんの要約
    fetchLines: [], buildgenLines: [], roadgenLines: [],
    gpuSamples: []       // renderer.info の定期サンプル
  };

  // --- 1) 既存の2秒おき診断ログを溜める(コンソールを遡らずに集計するため) -------
  const _log = console.log.bind(console);
  console.log = function () {
    try {
      const s = Array.prototype.map.call(arguments, v => (typeof v === 'string' ? v : String(v))).join(' ');
      const push = (arr, cap) => { arr.push(s); if (arr.length > cap) arr.shift(); };
      if (s.indexOf('[coastline] tile') === 0) push(P.coastTileLogs, 4000);
      else if (s.indexOf('[fetch]') === 0) push(P.fetchLines, 400);
      else if (s.indexOf('[buildgen]') === 0) push(P.buildgenLines, 400);
      else if (s.indexOf('[roadgen]') === 0) push(P.roadgenLines, 400);
    } catch (e) { /* 計測がゲームを壊さないこと最優先 */ }
    return _log.apply(console, arguments);
  };

  // --- 2) processCoastlineFill をラップして「バッチが何を持って来たか」を記録 -------
  // ねらい: 海面が塗られないタイルについて、
  //   (a) そもそも coastline way が応答に含まれていなかったのか
  //   (b) 含まれていたが ribbon/Phase2 が海と判定しなかったのか
  //   (c) sea予算切れ(budgetFail)だったのか
  // を区別する。(a)だと seenCoastlineTiles に印だけ付いて永久に陸のままになる。
  const _origFill = window.processCoastlineFill;
  if (typeof _origFill === 'function') {
    window.processCoastlineFill = function (elements, tileList) {
      try {
        let open = 0, closed = 0;
        for (const el of (elements || [])) {
          if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
          if (!el.tags || el.tags.natural !== 'coastline') continue;
          const g = el.geometry, a = g[0], b = g[g.length - 1];
          if (g.length >= 4 && Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7) closed++;
          else open++;
        }
        const keys = (tileList || []).map(t => t.tx + ',' + t.tz);
        const already = (typeof seenCoastlineTiles !== 'undefined')
          ? keys.filter(k => seenCoastlineTiles.has(k)).length : -1;
        P.coastBatches.push({
          sec: Math.round((Date.now() - P.t0) / 1000),
          kind: (tileList && tileList[0]) ? tileList[0].kind : '?',
          openWays: open, islands: closed, tiles: keys.length, alreadySeen: already, keys
        });
      } catch (e) { /* noop */ }
      return _origFill.apply(this, arguments);
    };
  } else {
    console.warn('[probe] processCoastlineFill が見つかりません(スクリプト読み込み前に貼った可能性)');
  }

  // --- 3) GPU/描画のサンプリング(5秒おき) --------------------------------------
  P._timer = setInterval(function () {
    try {
      const i = renderer.info;
      P.gpuSamples.push({
        sec: Math.round((Date.now() - P.t0) / 1000),
        geometries: i.memory.geometries, textures: i.memory.textures,
        calls: i.render.calls, triangles: i.render.triangles,
        areaPolys: (typeof areaPolyMeshes !== 'undefined') ? areaPolyMeshes.length : -1,
        pendWaterRetry: (typeof pendingAreaWaterPolys !== 'undefined') ? pendingAreaWaterPolys.length : -1,
        seaBudgetLeft: (typeof areaPolyBudget !== 'undefined') ? areaPolyBudget.sea : -1,
        waterBudgetLeft: (typeof areaPolyBudget !== 'undefined') ? areaPolyBudget.water : -1
      });
      if (P.gpuSamples.length > 400) P.gpuSamples.shift();
    } catch (e) { /* noop */ }
  }, 5000);

  console.log('%c[probe] 導入完了。目的地へジャンプ→30〜60秒待つ→ __cdReport() を実行してください。',
    'color:#0a0;font-weight:bold');
})();

/* ==========================================================================
 * 集計レポート
 * ========================================================================== */
/* --------------------------------------------------------------------------
 * 川が地面に見える件の専用プローブ(2026-08-12 追加)
 * 30秒あけて2回呼び、「プロファイル未確定」の件数が減るかどうかを見る。
 * ------------------------------------------------------------------------ */
window.__cdWater = function () {
  const px = player.position.x, pz = player.position.z;
  let flat = 0, sea = 0, nullProf = 0, meshDead = 0;
  const rows = [];
  for (const e of areaPolyMeshes) {
    if (e.kind !== 'flat') continue;
    flat++;
    if (e.areaKind === 'sea') { sea++; continue; }
    if (e.waterProfile) continue;
    nullProf++;
    if (!e.mesh) meshDead++;
    const cx = (e.minX + e.maxX) / 2, cz = (e.minZ + e.maxZ) / 2;
    const c = xzToLatLon(cx, cz);
    const t = (typeof terrainYOrNull === 'function') ? terrainYOrNull(cx, cz) : undefined;
    rows.push({
      dist_m: Math.round(Math.hypot(cx - px, cz - pz)),
      mesh生存: !!e.mesh,                                   // false なら二度と再計算されない(rebuildAreaPolyMeshが即return)
      収集ノード数: e.waterNodeInfo ? e.waterNodeInfo.nodes.length / 3 : -1,
      terrainYOrNull: t === null ? '(欠測null)' : (t === undefined ? '?' : +t.toFixed(2)),
      groundY: +getGroundY(cx, cz).toFixed(2),
      暫定waterY: +_waterYAt(e, cx, cz).toFixed(2),          // = groundY + 0.15 になっているはず
      gmaps: 'https://www.google.com/maps?q=' + c.lat.toFixed(5) + ',' + c.lon.toFixed(5)
    });
  }
  rows.sort((a, b) => a.dist_m - b.dist_m);
  console.log('%c=== 川/池の水位が決まっていない面 ===', 'font-weight:bold;color:#06c');
  console.log('flat面 合計=' + flat, '/ うち海(固定高さ)=' + sea,
    '/ 川・池でプロファイル未確定=' + nullProf, '(うちmesh解放済み=' + meshDead + ')');
  console.log('予算残:', JSON.stringify(areaPolyBudget),
    '/ 予算切れ再試行キュー pendingAreaWaterPolys=' + pendingAreaWaterPolys.length);
  console.table(rows.slice(0, 20));
  console.log('※ 30秒後にもう一度 __cdWater() を実行し、この件数が減るかを見ること。');
  return nullProf;
};

/* --------------------------------------------------------------------------
 * 新方式(輪郭ノードだけの低位パーセンタイル)を、コードを変えずに試算する
 * (2026-08-12 追加。プローブ本体とは独立。この関数だけ貼っても動く)
 *
 * 見たいこと:
 *   1. 新方式の水位が、今の水位より妥当か(=地形に近い値になるか)
 *   2. ポリゴン1枚が何mの長さか(=1枚1水平面で勾配が足りるか)
 *   3. 輪郭ノードの欠測率(=そもそもDEMが答えてくれるのか)
 * ------------------------------------------------------------------------ */
window.__cdNewLevel = function (limit) {
  const px = player.position.x, pz = player.position.z;
  const pct = (sorted, q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  const rows = [];
  let downCount = 0, upCount = 0, noDataCount = 0;
  const diffs = [], spans = [];
  for (const e of areaPolyMeshes) {
    if (e.kind !== 'flat' || e.areaKind === 'sea') continue;
    if (!e.pts || e.pts.length < 3) continue;
    // 輪郭ノード(=OSMの実測点)だけをサンプルする。内部の格子点は一切見ない。
    const stride = Math.max(1, Math.floor(e.pts.length / 400));
    const hs = [];
    let miss = 0, tried = 0;
    for (let i = 0; i < e.pts.length; i += stride) {
      const p = e.pts[i];
      tried++;
      const h = terrainYOrNull(p.x, p.z);
      if (h === null || h === undefined) { miss++; continue; } // 欠測は0に潰さず捨てる
      hs.push(h);
    }
    const cx = (e.minX + e.maxX) / 2, cz = (e.minZ + e.maxZ) / 2;
    const cur = _waterYAt(e, cx, cz);
    const span = Math.round(Math.max(e.maxX - e.minX, e.maxZ - e.minZ));
    spans.push(span);
    const c = xzToLatLon(cx, cz);
    if (hs.length === 0) {
      noDataCount++;
      rows.push({ dist_m: Math.round(Math.hypot(cx - px, cz - pz)), 長辺m: span,
        輪郭点: tried, 欠測: miss, 現水位: +cur.toFixed(2), 新p10: '(全欠測)', 差: '-',
        gmaps: 'https://www.google.com/maps?q=' + c.lat.toFixed(5) + ',' + c.lon.toFixed(5) });
      continue;
    }
    hs.sort((a, b) => a - b);
    const p10 = hs.length <= 3 ? hs[0] : pct(hs, 0.10);
    const diff = p10 - cur;
    diffs.push(diff);
    if (diff < -0.5) downCount++; else if (diff > 0.5) upCount++;
    rows.push({
      dist_m: Math.round(Math.hypot(cx - px, cz - pz)),
      長辺m: span,
      輪郭点: tried, 欠測: miss,
      現水位: +cur.toFixed(2),
      新p10: +p10.toFixed(2),
      新min: +hs[0].toFixed(2),
      新中央: +pct(hs, 0.5).toFixed(2),
      新max: +hs[hs.length - 1].toFixed(2),
      差: +diff.toFixed(2),
      gmaps: 'https://www.google.com/maps?q=' + c.lat.toFixed(5) + ',' + c.lon.toFixed(5)
    });
  }
  rows.sort((a, b) => a.dist_m - b.dist_m);
  const med = a => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log('%c=== 新方式(輪郭ノードのp10)の試算 ===', 'font-weight:bold;color:#06c');
  console.log('対象ポリゴン=' + rows.length,
    '/ 下がる=' + downCount, '/ 上がる=' + upCount, '/ 輪郭が全欠測=' + noDataCount);
  console.log('差(新-現) 中央値=' + (diffs.length ? med(diffs).toFixed(2) : '-'),
    '最小=' + (diffs.length ? Math.min.apply(null, diffs).toFixed(2) : '-'),
    '最大=' + (diffs.length ? Math.max.apply(null, diffs).toFixed(2) : '-'));
  console.log('ポリゴン長辺 中央値=' + med(spans) + 'm',
    '最大=' + (spans.length ? Math.max.apply(null, spans) : '-') + 'm',
    '(1枚1水平面で勾配が足りるかの判断材料)');
  console.table(rows.slice(0, limit || 25));
  console.log('※ 近い数件は gmaps を開いて、その川の実際の標高と突き合わせること。');
  return rows;
};

window.__cdReport = function () {
  const P = window.__CD_PROBE;
  if (!P) { console.warn('プローブが未導入です'); return; }
  const T = OSM_TILE_M;
  const px = player.position.x, pz = player.position.z;
  const bold = 'font-weight:bold;color:#06c';

  /* ---------- (A-1) 海: 「処理済みなのに海面ポリゴンが1枚も無い」タイル ---------- */
  const seaByTile = new Map();
  for (const e of areaPolyMeshes) {
    if (e.areaKind !== 'sea') continue;
    const cx = (e.minX + e.maxX) / 2, cz = (e.minZ + e.maxZ) / 2;
    const k = Math.floor(cx / T) + ',' + Math.floor(cz / T);
    seaByTile.set(k, (seaByTile.get(k) || 0) + 1);
  }
  // 各タイルについて「そのタイルを処理したバッチに coastline way が何本あったか」の最大値
  const waysSeenForTile = new Map();
  for (const b of P.coastBatches) {
    for (const k of b.keys) {
      waysSeenForTile.set(k, Math.max(waysSeenForTile.get(k) || 0, b.openWays));
    }
  }
  const suspects = [];
  for (const k of seenCoastlineTiles) {
    if (seaByTile.has(k)) continue;
    const p = k.split(',');
    const tx = +p[0], tz = +p[1];
    const cx = (tx + 0.5) * T, cz = (tz + 0.5) * T;
    const c = xzToLatLon(cx, cz);
    const tileLog = P.coastTileLogs.filter(s => s.indexOf('tile ' + k + ':') >= 0);
    suspects.push({
      tile: k,
      dist_m: Math.round(Math.hypot(cx - px, cz - pz)),
      // 0 なら「応答に海岸線が1本も入っていなかった」= 原因(a)。>0 なら判定側の問題。
      openWaysInBatch: waysSeenForTile.has(k) ? waysSeenForTile.get(k) : '(未観測)',
      phase12Log: tileLog.length ? tileLog[tileLog.length - 1].replace('[coastline] tile ' + k + ': ', '') : '(ログ無し=nearWays0で早期return)',
      gmaps: 'https://www.google.com/maps?q=' + c.lat.toFixed(5) + ',' + c.lon.toFixed(5)
    });
  }
  suspects.sort((a, b) => a.dist_m - b.dist_m);
  console.log('%c=== (A-1) 海: 処理済み(seen)なのに海面ポリゴンゼロのタイル ===', bold);
  console.log('seen=' + seenCoastlineTiles.size,
    '/ 海面ありタイル=' + seaByTile.size,
    '/ 陸化候補=' + suspects.length,
    '/ sea予算残=' + areaPolyBudget.sea);
  console.log('※ gmaps を開いて「そこが本当に水面か」を必ず突き合わせること(陸なら正常)');
  console.table(suspects.slice(0, 30));

  /* ---------- (A-2) 海: budgetFail / empty の総数 ---------- */
  let bf = 0, emp = 0, built = 0;
  for (const s of P.coastTileLogs) {
    const m1 = s.match(/built=(\d+)/), m2 = s.match(/empty=(\d+)/), m3 = s.match(/budgetFail=(\d+)/);
    if (m1) built += +m1[1];
    if (m2) emp += +m2[1];
    if (m3) bf += +m3[1];
  }
  console.log('%c=== (A-2) 海: Phase1/2の内訳(タイルログ合計) ===', bold);
  console.log('built=' + built, 'empty(クリップ結果が退化)=' + emp, 'budgetFail(予算切れで永久喪失)=' + bf);

  /* ---------- (A-3) バッチ単位: 海岸線データの届き方 ---------- */
  console.log('%c=== (A-3) processCoastlineFill バッチ記録(直近20件) ===', bold);
  console.table(P.coastBatches.slice(-20).map(b => ({
    sec: b.sec, kind: b.kind, openWays: b.openWays, islands: b.islands,
    tiles: b.tiles, alreadySeen: b.alreadySeen
  })));

  /* ---------- (A-4) 水面の浮き上がり: 足元と周辺のY比較 ---------- */
  console.log('%c=== (A-4) 水面の高さ(浮き上がり) ===', bold);
  const rows = [];
  for (const d of [0, 50, 100, 200, 400]) {
    for (const dir of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const x = px + dir[0] * d, z = pz + dir[1] * d;
      const w = (typeof waterSurfaceYAt === 'function') ? waterSurfaceYAt(x, z) : null;
      if (w === null || w === undefined) continue;
      const tRaw = (typeof terrainYOrNull === 'function') ? terrainYOrNull(x, z) : null;
      rows.push({
        d_m: d, dir: dir[0] + ',' + dir[1],
        waterY: +w.toFixed(2),
        terrainY: tRaw === null ? '(欠測null)' : +tRaw.toFixed(2),
        水面が地形より高い_m: tRaw === null ? '-' : +(w - tRaw).toFixed(2)
      });
      if (d === 0) break;
    }
  }
  console.table(rows);
  console.log('固定海面Y = ' + (seaLevelY() + seaYOffset()).toFixed(2),
    '(seaLevelY=' + seaLevelY().toFixed(2) + ' + yOff=' + seaYOffset().toFixed(2) + ')',
    '/ プレイヤーY=' + player.position.y.toFixed(2));
  // 川(waterProfile持ち)のうち近いものを1つ、プロファイルの中身ごと出す
  let near = null, nearD = Infinity;
  for (const e of areaPolyMeshes) {
    if (e.kind !== 'flat' || !e.waterProfile) continue;
    const cx = (e.minX + e.maxX) / 2, cz = (e.minZ + e.maxZ) / 2;
    const d = Math.hypot(cx - px, cz - pz);
    if (d < nearD) { nearD = d; near = e; }
  }
  if (near) {
    const M = near.waterProfile.M || [];
    console.log('最寄り水面ポリゴン: areaKind=' + near.areaKind, 'dist=' + Math.round(nearD) + 'm',
      'ビン数=' + M.length,
      'M(高さ列) min=' + Math.min.apply(null, M).toFixed(2) + ' max=' + Math.max.apply(null, M).toFixed(2));
  }

  /* ---------- (C) 性能 ---------- */
  console.log('%c=== (C) 性能 ===', bold);
  const last = a => (a.length ? a[a.length - 1] : '(記録なし)');
  console.log(last(P.fetchLines));
  console.log(last(P.buildgenLines));
  console.log(last(P.roadgenLines));
  console.log('%c-- renderer.info 推移(5秒間隔・直近12点) --', bold);
  console.table(P.gpuSamples.slice(-12));
  // 建物の空回り率(requeued/generated)
  let g = 0, r = 0;
  for (const s of P.buildgenLines) {
    const mg = s.match(/generated\/2s (\d+)/), mr = s.match(/requeued\/2s (\d+)/);
    if (mg) g += +mg[1];
    if (mr) r += +mr[1];
  }
  console.log('建物: generated合計=' + g, 'requeued合計=' + r,
    r > 0 ? '(空回り率 ' + (r / Math.max(1, g)).toFixed(2) + '倍)' : '');
  console.log('%c=== ここまで。console右クリック→Save as... で全文を保存して共有してください ===', bold);
  return { suspects, coastBatches: P.coastBatches, gpu: P.gpuSamples };
};
