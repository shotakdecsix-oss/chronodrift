/* ============================================================================
 * ChronoDrift 実測プローブ 2026-08-13 — 海岸線からリングを組み立てられるかの検証
 *
 * 使い方: 本番URLをPC Chromeで開き、NY(ハドソン川河口)へジャンプ、60〜90秒待ってから
 *         このファイル全体をコンソールに貼って Enter。__cdRings() が自動実行される。
 *
 * ゲーム本体のコードは一切変更しない。判定にも描画にも接続しない。
 * 「組み立てた結果が正しいか」だけを目で確かめるためのもの。
 *
 * 確かめたいこと:
 *   Q1. 取得済みの coastline way を端点でつなぐと、いくつの連なり(chain)になるか
 *   Q2. そのうち閉じるもの(=島・本土の輪郭)はあるか。マンハッタンは閉じるか
 *   Q3. 閉じたリングの内側判定(pointInPolygon)で、既知の陸/水を正しく分類できるか
 *   Q4. 閉じないchainはどこで切れているか(=取得範囲の端か、データの欠けか)
 * ========================================================================== */
window.__cdRings = function (storeName) {
  // --- 0) 海岸線ストアを探す -------------------------------------------------
  const names = storeName ? [storeName]
    : ['coastlineWayStore', 'coastlineStore', 'coastlineWays', '_coastlineWayStore'];
  let store = null, used = null;
  for (const n of names) {
    try { const v = eval(n); if (v && (v.size || v.length)) { store = v; used = n; break; } } catch (e) {}
  }
  if (!store) {
    console.warn('海岸線ストアが見つかりません。試した名前: ' + names.join(', ') +
      '\n正しい変数名が分かれば __cdRings("その名前") で再実行してください。');
    return;
  }
  const ways = [];
  const src = (store instanceof Map) ? Array.from(store.values()) : Array.from(store);
  for (const w of src) if (w && w.pts && w.pts.length >= 2) ways.push(w.pts);
  console.log('%c=== 海岸線リング組み立て検証 ===', 'font-weight:bold;color:#06c');
  console.log('ストア変数=' + used + ' / way数=' + ways.length);

  // --- 1) 端点でつないで chain にする ---------------------------------------
  const EPS = 1.0;                    // 端点が一致とみなす距離(m)
  const key = p => Math.round(p.x / EPS) + '|' + Math.round(p.z / EPS);
  const ends = new Map();             // 端点key -> [wayIndex,...]
  const addEnd = (p, i) => {
    const k = key(p);
    if (!ends.has(k)) ends.set(k, []);
    ends.get(k).push(i);
  };
  ways.forEach((pts, i) => { addEnd(pts[0], i); addEnd(pts[pts.length - 1], i); });

  const usedWay = new Array(ways.length).fill(false);
  const chains = [];
  const takeNext = (p, exclude) => {  // 端点pにつながる未使用のwayを1本返す
    const list = ends.get(key(p)) || [];
    for (const i of list) { if (!usedWay[i] && i !== exclude) return i; }
    return -1;
  };
  for (let s = 0; s < ways.length; s++) {
    if (usedWay[s]) continue;
    usedWay[s] = true;
    let chain = ways[s].slice();
    // 前方向へ伸ばす
    for (;;) {
      const i = takeNext(chain[chain.length - 1], -1);
      if (i < 0) break;
      usedWay[i] = true;
      const w = ways[i];
      const sameStart = key(w[0]) === key(chain[chain.length - 1]);
      const add = sameStart ? w.slice(1) : w.slice(0, -1).reverse();
      chain = chain.concat(add);
      if (chain.length > 200000) break; // 暴走防止
    }
    // 後方向へ伸ばす
    for (;;) {
      const i = takeNext(chain[0], -1);
      if (i < 0) break;
      usedWay[i] = true;
      const w = ways[i];
      const sameEnd = key(w[w.length - 1]) === key(chain[0]);
      const add = sameEnd ? w.slice(0, -1) : w.slice(1).reverse();
      chain = add.concat(chain);
      if (chain.length > 200000) break;
    }
    chains.push(chain);
  }

  const lenOf = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i-1].x, pts[i].z - pts[i-1].z); return L; };
  const areaOf = pts => { let A = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i+1)%pts.length]; A += a.x*b.z - b.x*a.z; } return A/2; };
  const isClosed = pts => Math.hypot(pts[0].x - pts[pts.length-1].x, pts[0].z - pts[pts.length-1].z) <= EPS * 2;

  const closed = chains.filter(isClosed);
  const open = chains.filter(c => !isClosed(c));
  console.log('chain数=' + chains.length + ' / 閉じた=' + closed.length + ' / 開いた=' + open.length);

  // --- 2) 閉じたリング一覧(面積の大きい順) --------------------------------
  const ringRows = closed.map(pts => {
    let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
    for (const p of pts) { minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z); }
    const cx=(minX+maxX)/2, cz=(minZ+maxZ)/2, c=xzToLatLon(cx,cz), A=areaOf(pts);
    return { 点数: pts.length, 周長km: +(lenOf(pts)/1000).toFixed(2),
      面積km2: +(Math.abs(A)/1e6).toFixed(2), 向き: A > 0 ? '正' : '負',
      長辺m: Math.round(Math.max(maxX-minX, maxZ-minZ)),
      gmaps: 'https://www.google.com/maps?q=' + c.lat.toFixed(5) + ',' + c.lon.toFixed(5),
      _pts: pts };
  }).sort((a,b) => b.面積km2 - a.面積km2);
  console.log('%c-- 閉じたリング(面積の大きい順15件)。gmapsで何の島/陸かを目視すること --', 'font-weight:bold;color:#06c');
  console.table(ringRows.slice(0,15).map(r => ({ 点数:r.点数, 周長km:r.周長km, 面積km2:r.面積km2, 向き:r.向き, 長辺m:r.長辺m, gmaps:r.gmaps })));

  // --- 3) 閉じなかった chain(長い順)。どこで切れているか -------------------
  const openRows = open.map(pts => {
    const a = xzToLatLon(pts[0].x, pts[0].z), b = xzToLatLon(pts[pts.length-1].x, pts[pts.length-1].z);
    return { 点数: pts.length, 長さkm: +(lenOf(pts)/1000).toFixed(2),
      始点: 'https://www.google.com/maps?q=' + a.lat.toFixed(5) + ',' + a.lon.toFixed(5),
      終点: 'https://www.google.com/maps?q=' + b.lat.toFixed(5) + ',' + b.lon.toFixed(5) };
  }).sort((a,b) => b.長さkm - a.長さkm);
  console.log('%c-- 閉じなかったchain(長い順10件)。端点が取得範囲の端なら正常、途中なら欠け --', 'font-weight:bold;color:#06c');
  console.table(openRows.slice(0,10));

  // --- 4) 既知の陸/水で分類を検算する ---------------------------------------
  // NYの既知地点。lat, lon, 期待
  const TESTS = [
    ['タイムズスクエア',        40.7580, -73.9855, '陸'],
    ['ウォール街',              40.7061, -74.0087, '陸'],
    ['プロスペクトパーク(BK)',  40.6602, -73.9690, '陸'],
    ['ジャージーシティ市街',    40.7178, -74.0431, '陸'],
    ['ガバナーズ島',            40.6895, -74.0165, '陸'],
    ['ハドソン川(中央)',       40.7100, -74.0200, '水'],
    ['イーストリバー(中央)',   40.7050, -73.9950, '水'],
    ['アッパー湾',              40.6700, -74.0500, '水'],
    ['ナローズ',                40.6060, -74.0450, '水']
  ];
  const rows = [];
  for (const [name, lat, lon, expect] of TESTS) {
    const p = latLonToXZ(lat, lon);
    let inside = 0;
    for (const r of ringRows) if (pointInPolygon(p.x, p.z, r._pts)) inside++;
    // リングの内側=陸 と仮定した場合の判定(奇数なら内側)
    const judged = (inside % 2 === 1) ? '陸' : '水';
    rows.push({ 地点: name, 期待: expect, 含むリング数: inside, '内側=陸とした判定': judged,
      一致: judged === expect ? 'OK' : '×' });
  }
  console.log('%c-- 既知地点での検算(「リングの内側=陸」と仮定) --', 'font-weight:bold;color:#06c');
  console.table(rows);
  const ok = rows.filter(r => r.一致 === 'OK').length;
  console.log('一致 ' + ok + '/' + rows.length +
    '  ※全部×なら向きが逆(内側=水)。半分だけ合うならリングが閉じ切れていない。');

  console.log('%c=== console右クリック→Save as... で全文を保存して共有してください ===', 'font-weight:bold;color:#06c');
  return { ways: ways.length, chains: chains.length, closed: closed.length, open: open.length, ringRows, openRows, rows };
};
console.log('%c[probe] __cdRings() を実行してください。', 'color:#0a0;font-weight:bold');
