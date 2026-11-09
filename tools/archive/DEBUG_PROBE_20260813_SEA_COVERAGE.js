/* ============================================================================
 * ChronoDrift 実測プローブ 2026-08-13 —「湾が地面に見える」範囲を数える
 *
 * 使い方: 本番URLをPC Chromeで開き、NY(ハドソン川河口・ジャージーシティ沖)へジャンプ、
 *         60秒待ってから、このファイル全体をコンソールに貼って Enter。
 *
 * コードは一切変更しない。デプロイ不要。リロードで消える。
 *
 * 知りたいこと:
 *   Q1. 海面ポリゴンの中で、地形が海面より高い(=地面に見える)点はどれくらいあるか
 *   Q2. その「高さの超過分」は連続分布か、それとも2つの山に分かれるか
 *        → 0〜3 に集中  = DEMが水域上で返す捏造値。しきい値で切れる
 *        → 10超も多い   = ポリゴンが本物の陸を含んでいる。しきい値では切れない
 *   Q3. 陸を含んでいるのは Phase2「タイル全塗り」由来か、Phase1 ribbon 由来か
 * ========================================================================== */
window.__cdSea = function () {
  const seaTop = seaLevelY() + seaYOffset();       // 実際に描かれている海面の高さ
  const T = OSM_TILE_M;
  const polys = areaPolyMeshes.filter(e => e.kind === 'flat' && e.fixedY != null);
  if (polys.length === 0) {
    console.warn('海面ポリゴンが0件。fixedY を持つ面がありません(RIVER_DRAPES のコミットが入っていない可能性)');
    return;
  }
  // Phase2「タイル全塗り」の判定: 4点で、bboxがちょうどタイル1枚ぶん
  const isWholeTile = e => e.pts.length === 4 &&
    Math.abs((e.maxX - e.minX) - T) < 2 && Math.abs((e.maxZ - e.minZ) - T) < 2;
  const wholeTiles = polys.filter(isWholeTile);

  const STEP = 100;                 // 100m格子でサンプル
  const seen = new Set();           // 重なった海面ポリゴンで二重に数えないため
  const hist = { '欠測': 0, '海面以下(正常)': 0, '+0〜1': 0, '+1〜3': 0, '+3〜10': 0, '+10〜30': 0, '+30超': 0 };
  let total = 0, above = 0;
  const worst = [];                 // 超過が大きい点(=本物の陸である可能性が高い)

  for (const e of polys) {
    const whole = isWholeTile(e);
    for (let z = Math.ceil(e.minZ / STEP) * STEP; z <= e.maxZ; z += STEP)
      for (let x = Math.ceil(e.minX / STEP) * STEP; x <= e.maxX; x += STEP) {
        const key = x + ',' + z;
        if (seen.has(key)) continue;
        if (!pointInPolygon(x, z, e.pts)) continue;
        if (e.holes) {
          let inHole = false;
          for (const h of e.holes) { if (h.length >= 4 && pointInPolygon(x, z, h)) { inHole = true; break; } }
          if (inHole) continue;     // 島(穴)は陸なので対象外
        }
        seen.add(key);
        total++;
        const t = terrainYOrNull(x, z);
        if (t === null || t === undefined) { hist['欠測']++; continue; }
        const d = t - seaTop;
        if (d <= 0) { hist['海面以下(正常)']++; continue; }
        above++;
        if (d <= 1) hist['+0〜1']++;
        else if (d <= 3) hist['+1〜3']++;
        else if (d <= 10) hist['+3〜10']++;
        else if (d <= 30) hist['+10〜30']++;
        else hist['+30超']++;
        if (d > 3) worst.push({ 超過: +d.toFixed(1), x, z, 全塗りタイル: whole });
      }
  }

  console.log('%c=== 海面ポリゴンの内側で地形がどれだけ出ているか ===', 'font-weight:bold;color:#06c');
  console.log('海面ポリゴン=' + polys.length,
    '(うちPhase2タイル全塗り=' + wholeTiles.length + ' / Phase1 ribbon=' + (polys.length - wholeTiles.length) + ')');
  console.log('サンプル点(100m格子・重複除去後)=' + total,
    '/ 地形が海面より高い=' + above + ' (' + (100 * above / Math.max(1, total)).toFixed(1) + '%)');
  console.log('描かれている海面Y=' + seaTop.toFixed(2));
  console.table(Object.keys(hist).map(k => ({ 区分: k, 点数: hist[k],
    割合: (100 * hist[k] / Math.max(1, total)).toFixed(1) + '%' })));

  // 超過が大きい点(本物の陸の疑い)を、離れた場所から順に20件
  worst.sort((a, b) => b.超過 - a.超過);
  const picked = [], MINSEP = 400;
  for (const w of worst) {
    if (picked.some(p => Math.hypot(p.x - w.x, p.z - w.z) < MINSEP)) continue;
    const c = xzToLatLon(w.x, w.z);
    picked.push(Object.assign({}, w, {
      gmaps: 'https://www.google.com/maps?q=' + c.lat.toFixed(5) + ',' + c.lon.toFixed(5) }));
    if (picked.length >= 20) break;
  }
  console.log('%c-- 超過+3以上の地点(400m以上離して20件)。gmapsを開いて陸か水かを判定すること --',
    'font-weight:bold;color:#06c');
  console.table(picked.map(p => ({ 超過: p.超過, 全塗りタイル: p.全塗りタイル, gmaps: p.gmaps })));
  const wholeCount = worst.filter(w => w.全塗りタイル).length;
  console.log('超過+3以上の点 ' + worst.length + '件のうち、Phase2タイル全塗り由来=' + wholeCount +
    ' (' + (100 * wholeCount / Math.max(1, worst.length)).toFixed(0) + '%)');

  // Phase2 全塗りタイルそのものの一覧(陸を含んでいないかの目視用)
  const tiles = [];
  for (const e of wholeTiles) {
    const cx = (e.minX + e.maxX) / 2, cz = (e.minZ + e.maxZ) / 2;
    const c = xzToLatLon(cx, cz);
    tiles.push({ tile: Math.floor(cx / T) + ',' + Math.floor(cz / T),
      dist_m: Math.round(Math.hypot(cx - player.position.x, cz - player.position.z)),
      gmaps: 'https://www.google.com/maps?q=' + c.lat.toFixed(5) + ',' + c.lon.toFixed(5) });
  }
  tiles.sort((a, b) => a.dist_m - b.dist_m);
  console.log('%c-- Phase2「タイル全塗り」の一覧(近い順20件)。陸が入っていないか目視すること --',
    'font-weight:bold;color:#06c');
  console.table(tiles.slice(0, 20));
  console.log('%c=== console右クリック→Save as... で全文を保存して共有してください ===',
    'font-weight:bold;color:#06c');
  return { hist, worst, wholeTiles: tiles };
};
console.log('%c[probe] __cdSea() を実行してください。', 'color:#0a0;font-weight:bold');
