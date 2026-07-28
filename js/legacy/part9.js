/**
 * legacy/part9.js — index.html の巨大インラインスクリプトを行範囲のまま機械的に切り出した
 * ファイル(9/9・最終)。part8.js の続き。詳細は part1.js 冒頭のコメント参照。
 */
// ======= 山の森(プレイヤー周囲の一定範囲だけを描く=軽量) =======
// 木は建物・道路と同じく「近くだけ」描く。プレイヤーが一定距離動いたら森を作り直す。
// 木の位置・見た目は座標から決まる(plantTree)ので、作り直しても同じ木が並び、ちらつかない。
// 建物・道路のチャンクは半径 CHUNK_RADIUS で生成され CHUNK_RADIUS+2 で消える。
// 森はその中間(+1)に合わせ、建物と木が同じくらいの距離で現れ・消えるようにする。
// 【2026-07-16】CHUNK_RADIUSを8(960m)へ拡大した際、森が連動して1080mまで広がると
// 樹木の生成負荷が跳ね上がるため、森は従来の480m固定に切り離す(木は遠景での存在感が
// 建物より小さく、フォグ距離的にも480mで十分)。
const FOREST_R = PERF.forestR; // パフォーマンス設定に連動(標準480m)
const FOREST_REBUILD_STEP = CHUNK_SIZE / 2;        // 60mごとに再構築(建物の出現範囲に追従)
const FOREST_MIN_H = 30;          // 局所比高がこの高さ(≈15m)以上を「山」とみなす(平地の街には生えない)
const FOREST_SCATTER = 36;        // 散布グリッド間隔(m)。粗くして候補数=負荷を抑える
let _forestBX = Infinity, _forestBZ = Infinity;
// キュー投入時(タイル到着時)には近い順に並べていたが、その後プレイヤーが動くと
// 「近い順」が古くなる(投入時は遠かった建物が、移動後には最優先になっているのに
// キューの奥に埋もれたまま)。低頻度(~0.5秒ごと)で未処理分だけ距離順に並べ直し、
// 常にプレイヤーの現在地に近い建物・道路から生成されるようにする。
let _buildingSortFrame = 0;
let _roadSortFrame = 0;
// 【2026-07-21・ユーザー要望】建物生成が「データ取得待ち」なのか「取得後の生成処理待ち」
// なのかを切り分けるための計測。exploreOnUpdate内の建物生成ループ(下記)で、1件処理する
// たびにどの分岐を通ったかをカウントし、updateDebugTileOverlayの定期ログでまとめて出す
// (集計自体は毎フレームやってもインクリメントのみで軽量)。
let _bgGenerated = 0;      // 実際にaddBuildingまで進んだ件数
let _bgRequeued = 0;       // チャンク地形 or 周辺タイル未確定で末尾へ回された件数(生成には至っていない)
let _bgDormant = 0;        // 生成距離外 or bMax上限でdormantへ退避した件数
let _bgRevived = 0;        // 【2026-07-21・Fable5診断(dormant復帰)】dormant→pendingへ復帰した件数
                            // (reactivateNearbyDormantBuildings内で加算)。レート律速(予算不足)か
                            // 選択律速(近傍セルに復帰対象が見つからない)かの切り分けに使う。
let _bgEvicted = 0;        // 【2026-07-21・Fable5診断(v3)】unloadFarBuildingsが実際にbuildingRecords
                            // から除去した件数。records=95%で張り付いてもヒステグラム縮小(85%目標)が
                            // 本当に発火しているか(0なら不発、大きければ発火はしているのに
                            // 流入と釣り合って高止まりしているだけ)を切り分けるための計器。
let _lastBuildBudget = 0, _lastRoadBacklogForGate = 0, _lastCurTileRush = false;
// 毎フレームnewしない方針(_instMat等と同じパターン)。exploreOnUpdate/updateCameraで使い回す
// 短命Vector3をモジュールスコープに退避(CODE_REVIEW_20260717 P11)。
const _moveForward = new THREE.Vector3(), _moveRight = new THREE.Vector3();
const _idealCam = new THREE.Vector3(), _occTargetPos = new THREE.Vector3();

function resetPool(p) { p.n = 0; p.mesh.count = 0; p.mesh.instanceMatrix.needsUpdate = true; }

// 建物などの当たり判定ボックスが近くにあるか。空間ハッシュ(collGrid)で近傍セルだけ調べる。
// (以前の hasBuildingNearby は全建物を線形走査していたため、森の再構築が非常に重かった)
function boxNear(x, z, r) {
  const c = COLL_CELL;
  const gx0 = Math.floor((x - r) / c), gx1 = Math.floor((x + r) / c);
  const gz0 = Math.floor((z - r) / c), gz1 = Math.floor((z + r) / c);
  for (let gx = gx0; gx <= gx1; gx++)
    for (let gz = gz0; gz <= gz1; gz++) {
      const arr = collGrid.get(gx + ',' + gz);
      if (!arr) continue;
      for (const b of arr)
        if (x > b.min.x - r && x < b.max.x + r && z > b.min.z - r && z < b.max.z + r) return true;
    }
  return false;
}

// プレイヤー周囲 FOREST_R 内の山(FOREST_MIN_H〜TREELINE)へ木を敷き直す(近傍判定はO(1)相当で軽量)
function rebuildForest() {
  if (!regionBaseReady) return; // このリージョンの高度基準(TREELINE等)がまだ確定していない
  resetPool(forestTrunkP);
  forestLeafPools.forEach(resetPool);
  const px = player.position.x, pz = player.position.z;
  const R = FOREST_R, R2 = R * R, cell = FOREST_SCATTER;
  const gx0 = Math.floor((px - R) / cell), gx1 = Math.floor((px + R) / cell);
  const gz0 = Math.floor((pz - R) / cell), gz1 = Math.floor((pz + R) / cell);
  for (let gx = gx0; gx <= gx1; gx++)
    for (let gz = gz0; gz <= gz1; gz++) {
      const cx = gx * cell, cz = gz * cell;
      const h = getGroundY(cx + cell / 2, cz + cell / 2);
      if (h < FOREST_MIN_H || h > TREELINE) continue; // 平地・森林限界より上は除外
      const dens = Math.min(6, 2 + ((h - FOREST_MIN_H) / 60 | 0)); // 高いほど密(控えめ=軽量)
      for (let i = 0; i < dens; i++) {
        const x = cx + _fhash(gx * 92821 + i, gz * 68917) * cell;
        const z = cz + _fhash(gx * 40503, gz * 51787 + i * 131) * cell;
        const dx = x - px, dz = z - pz;
        if (dx * dx + dz * dz > R2) continue;   // 円形範囲に収める
        if (roadNear(x, z, 2)) continue;        // 道路の上には生やさない(空間グリッドで高速判定)
        if (boxNear(x, z, 5)) continue;         // 建物の上には生やさない(空間グリッドで高速判定)
        if (isNearWater(x, z, 2)) continue;     // 山中の池・ダム湖・川の上には生やさない
        plantTree(x, z);
      }
    }
}

// プレイヤーが FOREST_REBUILD_STEP 以上動いたら森を作り直す
function updateForest() {
  if (USES_MEIJI_LANDUSE ? !meijiReady : !initialWorldLoaded) return;
  const bx = Math.round(player.position.x / FOREST_REBUILD_STEP);
  const bz = Math.round(player.position.z / FOREST_REBUILD_STEP);
  if (bx === _forestBX && bz === _forestBZ) return;
  _forestBX = bx; _forestBZ = bz;
  rebuildForest();
}

// ======= デバッグ: タイルごとの地形・道路/線路・建物 読み込み状況の可視化 =======
// 【2026-07-19】ユーザーからのデバッグ要望。OSMタイル(OSM_TILE_M=1600m四方)単位で、
// 地形(NEAR高解像度グリッドの被覆)・道路/線路(roadReadyTiles)・建物(残件数)の
// 進捗を、プレイヤー周囲に半透明の色付き平面として3D世界に直接表示する。
// index.html #debugTileBtn(🩺)でオン/オフ(part7.jsで配線)。オフ中は平面をvisible=false
// にするだけで、集計処理自体を毎フレームスキップする(常時コストはほぼゼロ)。
let debugTileOverlayOn = false;
const debugTilePlanes = new Map(); // "tx,tz" → THREE.Mesh(平面は使い回し、破棄しない)
let _debugTileFrame = 0;
const DEBUG_TILE_COLORS = {
  unqueued: 0x555555,       // まだ道路タイルすらリクエストしていない
  fetching: 0xdd3333,       // リクエスト済みだが道路/線路が未確定(取得中・バックオフ中)
  waitTerrain: 0x3388dd,    // 道路/線路は確定・地形(NEAR高解像度グリッド)が未確定
  buildingPending: 0xffaa22,// 道路・地形は確定・道路メッシュ or 建物がまだ生成中/残っている
  done: 0x33cc55,           // 道路メッシュ・地形・既知の建物残件がすべて揃っている(表示上「完了」)
  gaveUp: 0x9b3fd4,         // 【2026-07-20】4回連続失敗で「諦めて」ready扱いになっただけ。実データは未着の可能性が高い
};
// 【2026-07-21・ユーザー要望】地形/道路線路/建物のどれがボトルネックか一目で分かるよう、
// 1タイル=1色の合成ステータスだけでなく、3項目を別々の色で同時可視化する。
// 地形(elevation NEAR grid)は道路のOSMタイル取得とは別系統の仕組み(player中心の
// 常時追従グリッドで、タイル単位のキューには乗っていない)なので、これを分けて見えるように
// することで「地形だけ予想外に遅れている」といった原因の切り分けがしやすくなる。
const DEBUG_LAYER_COLORS = {
  notReady: 0x555555, // 灰: まだ判定材料が無い(未取得 or 前提条件待ち)
  waiting:  0x3388dd, // 青: 取得/計算待ち
  fetching: 0xdd3333, // 赤: 取得中(道路/線路のみ。実際にネットワーク待ちの状態)
  pending:  0xffaa22, // 橙: データは届いたがメッシュ化/生成がまだ残っている
  ready:    0x33cc55, // 緑: 完了
  gaveUp:   0x9b3fd4, // 紫: 諦めてready扱いになっただけ(実データ未着の可能性)
};
// 1タイル=横に並んだ3枚の短冊(地形/道路線路/建物)。個々はMeshBasicMaterialの色だけを
// 毎回書き換える(ジオメトリ・マテリアルは使い回し、生成/破棄はしない)ので、3倍になっても
// 生成コストは増えない。オフ中はvisible=falseで集計自体をスキップする点は従来と同じ。
function _debugTilePlaneGroup(key) {
  let g = debugTilePlanes.get(key);
  if (!g) {
    g = new THREE.Group();
    const stripD = OSM_TILE_M * 0.92;
    const stripW = stripD / 3;
    const mkStrip = (offsetX) => {
      const geo = new THREE.PlaneGeometry(stripW * 0.86, stripD); // 短冊間に隙間を空けて見分けやすくする
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.45,
        depthWrite: false, side: THREE.DoubleSide, fog: false, // フォグで遠方が見えなくなるとデバッグにならないので無効化
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.x = offsetX;
      return m;
    };
    g.terrainMesh = mkStrip(-stripW);
    g.roadMesh = mkStrip(0);
    g.buildMesh = mkStrip(stripW);
    g.add(g.terrainMesh, g.roadMesh, g.buildMesh);
    g.rotation.x = -Math.PI / 2;
    g.renderOrder = 5;
    g.visible = false;
    scene.add(g);
    debugTilePlanes.set(key, g);
  }
  return g;
}
function setDebugTileOverlay(on) {
  debugTileOverlayOn = on;
  if (!on) { for (const m of debugTilePlanes.values()) m.visible = false; }
  else { _debugTileFrame = 0; updateDebugTileOverlay(true); }
}
function updateDebugTileOverlay(force) {
  if (!debugTileOverlayOn) return;
  _debugTileFrame++;
  if (!force && _debugTileFrame % 30 !== 0) return; // ~0.5秒ごと(常時1フレームおきだと集計コストが無駄)
  const ptx = Math.floor(player.position.x / OSM_TILE_M), ptz = Math.floor(player.position.z / OSM_TILE_M);
  const R = PERF.prefetchR + 1; // 実際に先読みされている範囲+1(境界も見えるように)
  // 建物の残件・完了件数をタイルごとに1回だけ集計(オーバーレイON時・0.5秒に1回のみなので負荷は軽微)
  const tileKeyOf = (x, z) => Math.floor(x / OSM_TILE_M) + ',' + Math.floor(z / OSM_TILE_M);
  const bump = (map, k) => map.set(k, (map.get(k) || 0) + 1);
  const pendingByTile = new Map(), dormantByTile = new Map(), doneByTile = new Map();
  for (let i = pendingBuildingIdx; i < pendingBuildings.length; i++) bump(pendingByTile, tileKeyOf(pendingBuildings[i].x, pendingBuildings[i].z));
  // 【2026-07-21・Fable5診断(b)の注意点】隔離キュー(chunkWaitBuildings/tileWaitBuildings)の
  // 建物もpendingByTileに含めないと、実際は「もうすぐ生成される」状態なのに表示上の
  // buildQueuedが実態より少なく出てしまう(退行)。
  for (const e of chunkWaitBuildings.values()) for (const b of e.arr) bump(pendingByTile, tileKeyOf(b.x, b.z));
  for (const e of tileWaitBuildings.values()) for (const b of e.arr) bump(pendingByTile, tileKeyOf(b.x, b.z));
  // 【2026-07-28】以前は dormantGrid 全件を0.5秒ごとに走査していたが、dormantは数万件規模まで
  // 育つ(経路シムでは20000超を実測)ため、表示されない遠方セルまで毎回舐めた上に
  // tileKeyOf で文字列キーを大量生成し、GC圧を無駄に上げていた。オーバーレイが表示するのは
  // プレイヤー周囲 R タイル分だけなので、対応するdormantセルだけを直接引く。
  {
    const cellsPerTile = Math.ceil(OSM_TILE_M / DORMANT_CELL);
    const gx0 = (ptx - R) * cellsPerTile, gx1 = (ptx + R + 1) * cellsPerTile;
    const gz0 = (ptz - R) * cellsPerTile, gz1 = (ptz + R + 1) * cellsPerTile;
    for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
      const arr = dormantGrid.get(gx + ',' + gz);
      if (arr) for (const b of arr) bump(dormantByTile, tileKeyOf(b.x, b.z));
    }
  }
  for (const rec of buildingRecords) bump(doneByTile, tileKeyOf(rec.x, rec.z));
  // 【2026-07-19】roadReadyTiles は「道路データを受信・登録済み」なだけで、実際の3Dメッシュ化
  // (processRoadMeshQueue、フレーム分割)はまだこれからのことがある。特にタイル到着直後は
  // 数百〜数千本がpendingRoadMeshesに積まれた瞬間で、データはreadyでも画面にはまだ何も
  // 出ていない。これを見ずにroadReadyだけで判定すると、直近タイルなのに道路・建物とも
  // 未描画のまま「完了(緑)」と誤表示してしまう(実機報告)。道路メッシュの残件もタイル単位で
  // 集計し、残っていれば「完了」扱いにしない。
  const roadMeshPendingByTile = new Map();
  for (const r of pendingRoadMeshes) bump(roadMeshPendingByTile, tileKeyOf((r.x1 + r.x2) / 2, (r.z1 + r.z2) / 2));
  const seen = new Set();
  const logRows = [];
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
    const tx = ptx + dx, tz = ptz + dz;
    const key = tx + ',' + tz;
    seen.add(key);
    const roadReady = roadReadyTiles.has(key);
    const queued = queuedTiles.has(key);
    const x0 = tx * OSM_TILE_M, x1 = x0 + OSM_TILE_M, z0 = tz * OSM_TILE_M, z1 = z0 + OSM_TILE_M;
    // chunkNearTerrainReady(part8.js)と同じ判定をタイル全体の箱に対して行う
    const terrainReady = _nearGiveUp || !!(nearElev &&
      x0 > nearCX - NEAR_W / 2 + 10 && x1 < nearCX + NEAR_W / 2 - 10 &&
      z0 > nearCZ - NEAR_D / 2 + 10 && z1 < nearCZ + NEAR_D / 2 - 10);
    const pending = (pendingByTile.get(key) || 0) + (dormantByTile.get(key) || 0);
    const done = doneByTile.get(key) || 0;
    const roadMeshPending = roadMeshPendingByTile.get(key) || 0;
    // 【2026-07-21・gaveUp判定の再設計(修正5)】以前はosmTileFailCount(全失敗を数える。
    // 429/502/504のようなインフラ側の一時障害も含む)が4に達したかどうかで判定していたため、
    // 429ストーム中は本来データに問題が無いタイルまで次々「諦め」表示になっていた。
    // 今はfetchOSMTileBatch(part8.js)側でインフラ障害を除外した専用カウンタ
    // (osmTileHardFailCount)を使って「本当に諦めた」タイルだけをgaveUpTilesへ登録するので、
    // ここでは再計算せずそのSetをそのまま参照する(単一の真実の情報源にする)。
    // 【2026-07-26・IMPL_PROMPT_20260724 Phase1】近傍(tier1+2)は道路/建物が別ジョブになり、
    // gaveUpTilesもkind別のstateKey("tx,tz|road"/"tx,tz|building")で登録されることがある
    // (tier3以遠・従来の複合クエリは今まで通り"tx,tz"のまま)。表示上はどちらのkindで
    // 諦めたのかを区別して見せる(道路が届いてるのに建物だけ諦めた場合を紫と誤認しないため)。
    const gaveUpRoad = gaveUpTiles.has(key) || gaveUpTiles.has(key + '|road');
    const gaveUpBuilding = gaveUpTiles.has(key) || gaveUpTiles.has(key + '|building');
    // 建物データそのものの到達状況。tier1+2の分離ジョブでは道路確定(roadReady)と建物到達
    // (buildingReadyTiles)が別タイミングになるため、buildColorはbuildingReadyTilesを見る。
    const buildingArrived = buildingReadyTiles.has(key);
    let status;
    if (!queued) status = 'unqueued';
    else if (!roadReady) status = 'fetching';
    else if (gaveUpRoad) status = 'gaveUp';
    else if (!terrainReady) status = 'waitTerrain';
    else if (!buildingArrived) status = 'buildingPending'; // 建物クエリ待ち(道路は確定済み)
    else if (roadMeshPending > 0 || pending > 0) status = 'buildingPending';
    else status = 'done';
    // 【2026-07-21・ユーザー要望】道路生成が「地形は緑なのに赤いまま」滞留するパターンの
    // 診断用。fetching状態のタイルが初めてキューに入ってから何ms経過したかを見える化する
    // (キューの優先順位が悪くて後回しにされているのか、優先度は正しいのに取得自体に
    // 時間がかかっているだけかを切り分ける)。
    const waitMs = (status === 'fetching') ? (Date.now() - (osmTileQueuedAt.get(key) || Date.now())) : 0;
    const cx = x0 + OSM_TILE_M / 2, cz = z0 + OSM_TILE_M / 2;
    // 【2026-07-19】中心の地面高さだけだと起伏のあるタイルで平面が地形に埋まって見えるため、
    // タイル内を3×3でサンプリングし一番高い点に合わせる(山がちなタイルでも埋まらない)。
    let topY = -Infinity;
    for (let sx = 0; sx <= 2; sx++) for (let sz = 0; sz <= 2; sz++) {
      const gy = getGroundY(x0 + OSM_TILE_M * sx / 2, z0 + OSM_TILE_M * sz / 2);
      if (gy > topY) topY = gy;
    }
    const group = _debugTilePlaneGroup(key);
    group.position.set(cx, topY + 0.6, cz);
    // 【2026-07-21・ユーザー要望】地形/道路線路/建物を短冊3本で個別に色分け。
    // 地形はOSMタイルのキューとは無関係に判定される(queuedでなくても地形自体は
    // 進んでいることがあるが、「このタイルの話として見るか」を揃えるためqueued前提にする)。
    const terrainColor = !queued ? DEBUG_LAYER_COLORS.notReady
      : terrainReady ? DEBUG_LAYER_COLORS.ready : DEBUG_LAYER_COLORS.waiting;
    let roadColor;
    if (!queued) roadColor = DEBUG_LAYER_COLORS.notReady;
    else if (gaveUpRoad) roadColor = DEBUG_LAYER_COLORS.gaveUp;
    else if (!roadReady) roadColor = DEBUG_LAYER_COLORS.fetching;
    else if (roadMeshPending > 0) roadColor = DEBUG_LAYER_COLORS.pending;
    else roadColor = DEBUG_LAYER_COLORS.ready;
    let buildColor;
    if (!queued || !roadReady) buildColor = DEBUG_LAYER_COLORS.notReady; // データ未着でまだ判定不能
    else if (gaveUpBuilding && !buildingArrived) buildColor = DEBUG_LAYER_COLORS.gaveUp; // 建物クエリだけ諦めた(道路は確定済み)
    else if (!buildingArrived) buildColor = DEBUG_LAYER_COLORS.fetching; // 道路確定済みだが建物クエリ(後追い)がまだ
    else if (pending > 0) buildColor = DEBUG_LAYER_COLORS.pending;
    else buildColor = DEBUG_LAYER_COLORS.ready;
    group.terrainMesh.material.color.setHex(terrainColor);
    group.roadMesh.material.color.setHex(roadColor);
    group.buildMesh.material.color.setHex(buildColor);
    group.visible = true;
    // 【2026-07-21・Fable5診断(d)】以前はpending(処理待ちキュー)とdormant(復帰待ちで
    // 眠っている分)を合算した1つの数字だけを表示しており、「今すぐ生成されそうな数」と
    // 「復帰待ちでまだ順番も回ってきていない数」の区別がつかず、密集地で「詰まっている」と
    // 誤読しやすかった(実態は復帰レート律速で正常な高止まり)。分けて出す。
    logRows.push({ tile: key, status, road: roadReady, roadMeshPending, waitMs, terrain: terrainReady, buildDone: done, buildQueued: pendingByTile.get(key) || 0, buildDormant: dormantByTile.get(key) || 0, fails: osmTileFailCount.get(key) || 0 });
  }
  // 範囲外に出た平面は隠す(近くに戻ってくる可能性が高いので基本は使い回す)。
  // 【2026-07-28】ただし従来は一度作った平面を永久に保持していたため、経路シムのように
  // 何kmも一方向へ走り続けるとGroup(短冊3枚=Mesh3個)が訪問タイル数だけ際限なく
  // scene.childrenへ溜まっていた(不可視でも毎フレームのシーン走査対象になる)。
  // 十分遠い(表示範囲の倍以上)ものはジオメトリ・マテリアルごと破棄する。
  // 再接近時は_debugTilePlaneGroupが作り直すので見た目は変わらない。
  const _evictR = R * 2 + 2;
  for (const [key, grp] of debugTilePlanes) {
    if (seen.has(key)) continue;
    grp.visible = false;
    const c = key.split(','), kx = +c[0], kz = +c[1];
    if (Math.abs(kx - ptx) <= _evictR && Math.abs(kz - ptz) <= _evictR) continue;
    scene.remove(grp);
    for (const m of [grp.terrainMesh, grp.roadMesh, grp.buildMesh]) { m.geometry.dispose(); m.material.dispose(); }
    debugTilePlanes.delete(key);
  }
  if (force || _debugTileFrame % 120 === 0) {
    console.table(logRows); // 詳細な数値は~2秒ごとにコンソールへ
    // 【2026-07-21・ユーザー要望】道路生成が「地形は緑なのに赤いまま」滞留するパターンの
    // 診断用。fetching状態のタイルのうち最も待ち時間が長いものを見て、キューの優先順位が
    // 悪いのか(近傍タイルなのに何十秒も待たされている)、単に取得自体に時間がかかって
    // いるだけなのか(osmTimeoutSecの範囲内で、他タイルより多少遅いだけ)を切り分ける。
    let maxWait = 0, maxWaitTile = null, fetchingCount = 0;
    for (const row of logRows) {
      if (row.status !== 'fetching') continue;
      fetchingCount++;
      if (row.waitMs > maxWait) { maxWait = row.waitMs; maxWaitTile = row.tile; }
    }
    console.log('[roadgen] fetchingTiles', fetchingCount, 'maxWaitMs', maxWait, 'maxWaitTile', maxWaitTile);
    // 【2026-07-21・修正7(a)】全面赤(fetching)で停止するケースの切り分け用計器。
    // 仮説A(グローバル・クールダウンが429継続で実質恒久化)なら cooldown(ms) が常に正の値になる。
    // 仮説B(ワーカー枠のリーク)なら active=3 に張り付いたまま cooldown=0 で queue が減らない。
    // 【2026-07-25・ユーザー報告(足元タイルが5分以上fetchingのまま)】上のwaitMs(キュー投入
    // からの経過)だけでは「まだ順番待ち」と「実際にfetchが動いているのに終わらない」を
    // 区別できないため、実際にfetchOSMTileBatchへ入ってからの経過(maxActiveAgeMs)を追加。
    // これがtileTimeoutMs(現在地70秒/他34-54秒)を大きく超えているなら、AbortControllerの
    // タイムアウトが機能せず本当にハングしている証拠になる。
    let _maxActiveAge = 0;
    for (const t of _activeFetchStarts.values()) _maxActiveAge = Math.max(_maxActiveAge, Date.now() - t);
    console.log('[fetch] active', osmTileActiveCount, 'queue', osmTileQueue.length,
      'cooldown(ms)', Math.max(0, osmGlobalCooldownUntil - Date.now()), 'maxActiveAgeMs', _maxActiveAge,
      'streak', _osm429Streak, 'records', buildingRecords.length, '/', PERF.bMax,
      'dormant', dormantCount);
    // 【2026-07-21・ユーザー要望】データ取得(上の[fetch]行)とは別に、取得後の生成処理側の
    // スループットを見る計器。budget/roadGate/rushは直近フレームのスナップショット、
    // gen/requeue/dormantはこの~2秒間の累計。requeueが支配的ならチャンク地形/周辺タイル
    // 未確定によるキューの「空回り」がボトルネック、genが少なくbudgetも小さいなら
    // 予算(roadBacklogGate)自体が絞られている、genはそこそこ多いのに全体のbuildPending
    // (上のテーブル)が減らないなら生成そのものより供給(OSM取得)側の方が速い、と切り分けられる。
    console.log('[buildgen] budget', _lastBuildBudget, 'roadBacklogGate', _lastRoadBacklogForGate,
      'rush', _lastCurTileRush, 'generated/2s', _bgGenerated, 'requeued/2s', _bgRequeued,
      'toDormant/2s', _bgDormant, 'pendingTotal', pendingBuildings.length - pendingBuildingIdx,
      // 【2026-07-21・Fable5診断(b)】隔離キューの規模(chunkWaitキー数/tileWaitキー数/合計件数)。
      // requeued/2sが今後小さくなっても、この件数が大きければ「空回りは止まったが、
      // ゲート不成立の建物自体はまだ多い」ことを示す(正常。スキャナが低頻度で捌く)。
      'gateWaitKeys', chunkWaitBuildings.size + tileWaitBuildings.size, 'gateWaitTotal', gateWaitTotalCount(),
      'revived/2s', _bgRevived, 'evicted/2s', _bgEvicted);
    _bgGenerated = 0; _bgRequeued = 0; _bgDormant = 0; _bgRevived = 0; _bgEvicted = 0;
  }
}

// ======= 常時メモリ計測(GPU/JSヒープの増加源の切り分け) =======
// 【2026-07-28・経路シム中のタブクラッシュ調査】
// これまでの対策(自販機等の撤去・木プール上限引き上げ・高架の距離アンロード・キュー自己
// スロットル)を入れてもクラッシュが再発しており、静的レビューでは決定打が出なかった。
// 過去の同種の調査(DEBUG_SESSION_20260716_BUILDINGS)では「renderer.infoの実測(geo/tex/
// calls/tri)と内訳カウントで切り分けるのが最速」という結論が出ているので、まず同じ計器を
// 常時稼働させる。狙いは「GPU側で伸びているのがジオメトリなのかテクスチャなのか」を
// 一発で分けること(これだけで探索範囲が半分になる)。
//
// 【重要】既存の[fetch]/[roadgen]/[buildgen]ログはupdateDebugTileOverlay内にあり、
// 🩺オーバーレイがONの時しか出ない。この[mem]ログはオーバーレイと無関係に常時出す
// (集計はMap.size等のO(1)参照と配列1周のみで、~2秒に1回なので負荷は無視できる)。
// また実機がiPhoneでリモートデバッグできないため、🩺ON時は画面にも同じ数値を出す。
let _memDiagFrame = 0;
let _memDiagPrev = null;
let _memHudEl = null;
function _memHud() {
  if (_memHudEl) return _memHudEl;
  const d = document.createElement('div');
  d.id = 'memHud';
  d.style.cssText = 'position:fixed;left:4px;top:4px;z-index:9999;pointer-events:none;'
    + 'font:10px/1.35 monospace;color:#7fffd4;background:rgba(0,0,0,0.55);'
    + 'padding:3px 5px;border-radius:4px;white-space:pre;display:none;';
  document.body.appendChild(d);
  _memHudEl = d;
  return d;
}
// ======= GPUバイト数の実測(個数ではなくバイト) =======
// 【2026-07-28・二分探索の結果を受けて】旧バージョン(BIRD/GPS追従/経路シム導入前)でも
// 移動を続けると落ちることが確認され、「昨日の変更が原因」という線は消えた。発動条件は
// 連続移動そのもの。同時に、std設定でも geo≒10,000 / tex≒700 しか無いのにGPUプロセスが
// 2GBという大きなズレが出ている。
// renderer.info.memory は「個数」しか返さないため、1個あたりが巨大なジオメトリ(地形の
// 高解像度グリッド等、数十万頂点)が積み上がっていても個数にはほとんど表れない。これまで
// 5巡ぶん個数ばかり見ていて空振りしていた原因はここだと判断し、実バイト数を直接数える。
// scene全体の走査になるので低頻度(~10秒ごと)に限定する。
let _gpuBytesFrame = 0;
// 【2026-07-28・「シーンに居ないのにGPUに残っている分」を実バイトで測る計器】
// これまでの[gpuBytes]はscene.traverse、つまり【今シーンに居るオブジェクトだけ】を数えていた。
// dispose漏れしたジオメトリは定義上シーンから外れているので、その計器には最初から映らない
// (renderer.info.memory.geometries と uniqGeo の差 6,354 がまさにそれ)。差の【個数】は
// 分かっても【バイト数】が分からないままだったので、WebGLの層で直接測る。
// やり方: rendererのGLコンテキストの bindBuffer / bufferData / deleteBuffer をラップして、
// 実際にGPUへ確保されたバイト数を加算し、削除されたら減算する。THREEが解放し忘れた分は
// 減算されないまま残るので、glBufMB がシーン走査の geoMB を大きく上回っていれば
// 「dispose漏れが本丸」と確定できる。逆に両者がほぼ一致するならリークは無く、
// GPUメモリの正体はWebGLの外(ドローイングバッファ等)だと確定できる。
// 描画そのものには一切干渉しない(元の関数をそのまま呼ぶだけ)。
let _glBufBytes = 0, _glBufCount = 0;
function installGlByteTracker() {
  try {
    const gl = renderer.getContext();
    if (!gl || gl.__byteTracked) return;
    gl.__byteTracked = true;
    const sizes = new Map();   // WebGLBuffer -> バイト数
    // 【性能上の注意】bindBufferは1フレームに数万回呼ばれる最ホットパスなのでラップしない。
    // bufferData(=アップロード時のみ)の中でバインド中のバッファを問い合わせる。
    // この種のバインディング取得はChromeのコマンドバッファがクライアント側にキャッシュ
    // しているためGPUとの同期は発生しない。
    const BIND_PNAME = new Map([
      [gl.ARRAY_BUFFER, gl.ARRAY_BUFFER_BINDING],
      [gl.ELEMENT_ARRAY_BUFFER, gl.ELEMENT_ARRAY_BUFFER_BINDING],
    ]);
    const _data = gl.bufferData.bind(gl);
    gl.bufferData = function (target, src, usage, srcOffset, length) {
      const r = arguments.length >= 4 ? _data(target, src, usage, srcOffset, length) : _data(target, src, usage);
      const pn = BIND_PNAME.get(target);
      const buf = pn === undefined ? null : gl.getParameter(pn);
      if (buf) {
        const n = typeof src === 'number' ? src : (src && src.byteLength) || 0;
        const prev = sizes.get(buf) || 0;
        _glBufBytes += n - prev;
        if (!prev) _glBufCount++;
        sizes.set(buf, n);
      }
      return r;
    };
    const _del = gl.deleteBuffer.bind(gl);
    gl.deleteBuffer = function (buf) {
      const prev = sizes.get(buf);
      if (prev !== undefined) { _glBufBytes -= prev; _glBufCount--; sizes.delete(buf); }
      return _del(buf);
    };
  } catch (e) { console.warn('[gpuBytes] GLトラッカーを設置できませんでした', e); }
}
installGlByteTracker();

function logGpuBytes() {
  if (++_gpuBytesFrame % 600 !== 0) return; // ~10秒ごと
  const seenGeo = new Set(), seenTex = new Set();
  let geoBytes = 0, texBytes = 0, meshCount = 0;
  const top = [];        // 単体で大きいジオメトリ上位(犯人の直接特定用)
  const byKind = new Map(); // 分類ごとの合計バイト
  scene.traverse((o) => {
    const g = o.geometry;
    if (g) {
      meshCount++;
      if (!seenGeo.has(g.uuid)) {
        seenGeo.add(g.uuid);
        let b = 0;
        for (const k in g.attributes) { const a = g.attributes[k]; if (a && a.array) b += a.array.byteLength; }
        if (g.index && g.index.array) b += g.index.array.byteLength;
        // InstancedMeshのインスタンス行列(count×16 float)も実際にGPUへ載るので含める
        if (o.isInstancedMesh && o.instanceMatrix && o.instanceMatrix.array) b += o.instanceMatrix.array.byteLength;
        geoBytes += b;
        const kind = o.name || (o.isInstancedMesh ? 'Inst:' + g.type : g.type);
        byKind.set(kind, (byKind.get(kind) || 0) + b);
        top.push({ b, kind, n: g.attributes.position ? g.attributes.position.count : 0 });
      }
    }
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      for (const slot of ['map', 'emissiveMap', 'normalMap', 'alphaMap']) {
        const t = m && m[slot];
        if (!t || seenTex.has(t.uuid) || !t.image) continue;
        seenTex.add(t.uuid);
        texBytes += (t.image.width || 0) * (t.image.height || 0) * 4 * 1.34; // mipmap込みの概算
      }
    }
  });
  top.sort((a, b) => b.b - a.b);
  const MB = (v) => (v / 1048576).toFixed(1);
  const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, v]) => k + ':' + MB(v)).join(' ');
  // 【2026-07-28】シーンの中身とは別に、既定ドローイングバッファ(常時GPU常駐の固定費)も出す。
  // ここが数百MB台なら、これまで「原因不明の95%」だったGPUメモリの正体はこれ(part1.js GFX参照)。
  let fb = '';
  try {
    const gl = renderer.getContext();
    const dw = gl.drawingBufferWidth, dh = gl.drawingBufferHeight;
    const smp = GFX.aa ? (gl.getParameter(gl.SAMPLES) || 4) : 1;
    // MSAAカラー + MSAA深度ステンシル + 解決後カラー(それぞれ4B/px)
    const fbBytes = dw * dh * 4 * (smp * 2 + 1);
    fb = ' | drawBuf ' + dw + 'x' + dh + ' dpr' + renderer.getPixelRatio().toFixed(2)
       + ' aa:' + (GFX.aa ? smp + 'x' : 'off') + ' fbMB ' + MB(fbBytes);
  } catch (e) {}
  console.log('[gpuBytes] geoMB ' + MB(geoBytes) + ' texMB ' + MB(texBytes)
    + ' | glBuf ' + _glBufCount + '本/' + MB(_glBufBytes) + 'MB 平均' + Math.round(_glBufBytes / Math.max(1, _glBufCount))
    + 'B 推定GPU実消費' + MB(_glBufCount * 65536) + 'MB' // 1本あたりD3D11の最小確保単位64KBを掛けた推定値
    + ' boxGeo' + (typeof facadeBoxCacheSize === 'function' ? facadeBoxCacheSize() : -1) + fb
    + ' meshes ' + meshCount + ' uniqGeo ' + seenGeo.size + ' uniqTex ' + seenTex.size
    + ' | 分類上位MB ' + kinds
    + ' | 最大 ' + top.slice(0, 3).map(t => t.kind + '(' + t.n + '頂点,' + MB(t.b) + 'MB)').join(' '));
}

function updateMemDiag() {
  logGpuBytes();
  if (++_memDiagFrame % 120 !== 0) return; // ~2秒ごと
  // 道路は「レコードは永久保持・meshだけ距離で解放」方式なので、総数とmesh保持数を分けて見る
  // (総数だけ伸びてmeshが伸びないならGPUは健全、meshが伸び続けるならアンロード漏れ)。
  let roadMesh = 0, motorwayMesh = 0;
  for (const r of roadRecords) { if (r.mesh) { roadMesh++; if (r.type === 'motorway') motorwayMesh++; } }
  let areaMesh = 0;
  for (const e of areaPolyMeshes) if (e.mesh) areaMesh++;
  const mem = renderer.info.memory, rnd = renderer.info.render;
  const heapMB = (performance.memory && performance.memory.usedJSHeapSize)
    ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1;
  const now = {
    geo: mem.geometries, tex: mem.textures,
    prog: renderer.info.programs ? renderer.info.programs.length : -1,
    calls: rnd.calls, tri: rnd.triangles,
    sceneCh: scene.children.length,
    bRec: buildingRecords.length, dormant: dormantCount,
    roadRec: roadRecords.length, roadMesh, motorwayMesh,
    areaMesh, areaRec: areaPolyMeshes.length,
    chunks: chunkMeshes.size, facade: facadeCache.size,
    dormCells: dormantGrid.size,
    // 【2026-07-28・3巡目】geo/tex/roadRec/dormantを抑えても落ちるため、まだ計器の無い
    // 「永久に増えうる配列・Set」を一通り出す。どれか1つだけが単調増加していればそれが次の的。
    pendB: pendingBuildings.length, pendRoad: pendingRoadMeshes.length,
    coll: collisionBoxes.length, mmB: minimapBuildings.length,
    ways: (typeof seenOSMWays !== 'undefined' ? seenOSMWays.size : -1),
    stn: (typeof stationLabels !== 'undefined' ? stationLabels.length : -1),
    roadG: roadGrid.size,
    dbgPlanes: debugTilePlanes.size, tileQ: osmTileQueue.length, heapMB,
  };
  // 前回との差分。クラッシュ前に「何が一貫して増え続けているか」を一目で見るための主目的。
  const d = _memDiagPrev ? {} : null;
  if (d) for (const k in now) d[k] = now[k] - _memDiagPrev[k];
  _memDiagPrev = now;
  // 【2026-07-28】オブジェクトのまま出すとコンソールで折りたたまれ、肝心のheapMB等が
  // 展開しないと読めない(実機ログ提供時に「…」で潰れた)。1行の文字列で出す。
  const sgnN = (v) => (v > 0 ? '+' + v : String(v));
  console.log('[mem] ' + Object.keys(now).map(k => k + ' ' + now[k] + (d ? '(' + sgnN(d[k]) + ')' : '')).join(' ')
    + ' | evicted/win dorm ' + _dormantEvicted + ' road ' + _roadEvicted);
  _dormantEvicted = 0; _roadEvicted = 0;
  if (debugTileOverlayOn) {
    const el = _memHud();
    el.style.display = 'block';
    const sgn = (v) => (v > 0 ? '+' + v : String(v));
    el.textContent =
      `geo ${now.geo} (${d ? sgn(d.geo) : '-'})   tex ${now.tex} (${d ? sgn(d.tex) : '-'})\n`
      + `heap ${now.heapMB}MB (${d ? sgn(d.heapMB) : '-'})   calls ${now.calls}\n`
      + `bRec ${now.bRec} dorm ${now.dormant}/${now.dormCells}c facade ${now.facade}\n`
      + `road ${now.roadMesh}/${now.roadRec} (mtw ${now.motorwayMesh})\n`
      + `area ${now.areaMesh} chunk ${now.chunks} scene ${now.sceneCh}\n`
      + `dbgPlanes ${now.dbgPlanes} tileQ ${now.tileQ}`;
  } else if (_memHudEl) {
    _memHudEl.style.display = 'none';
  }
}

// ======= ANIMATION LOOP =======
const clock = new THREE.Clock();
let walkCycle = 0;
let birdFlapCycle = 0; // BIRDモードの翼の羽ばたき用アキュムレータ(walkCycleと同じ仕組み)

// ======= EXPLORE MODE: 自由移動・ジャンプ・歩行アニメーション・追従カメラ =======
// 「3D探索」というゲームプレイそのものに属するロジックをここにまとめ、ModeRegistryの
// explore モードの onUpdate として登録する(下の registerMode 呼び出し参照)。
// 挙動・呼び出しタイミングは分割前と完全に同一(animate()の同じ位置から毎フレーム
// 呼ばれるだけで、処理の中身・順序は一切変えていない)。将来のRPG/アクション等の
// モードは、この関数を丸ごと差し替えることで全く異なる移動方式・カメラを実装できる。
// ワールドのストリーミング・描画(チャンク生成・地形・ミニマップ等)はモードに依らない
// 共通処理として animate() 側に残す。
function exploreOnUpdate(dt) {
  // 速度: 通常5m/s、最大3倍(15m/s)。スマホ=スティックの倒し量で連続加速、PC=Shiftダッシュ
  // 加速カーブを立たせ(pow0.7×1.15)、6割程度の倒しでも3倍近く出るように
  const joyMag = joyActive ? Math.min(1, Math.sqrt(joyOx*joyOx + joyOz*joyOz)) : 0;
  let speed = 5 + 40 * Math.min(1, Math.pow(joyMag, 0.7) * 1.15); // 最大45m/s
  if (keys['shift']) speed = 45;
  // 【2026-07-27・BIRDモード】水平速度をそのまま3倍(part7.js参照)。joystick加速・
  // Shiftダッシュを含めた結果を丸ごと倍にするので、通常時の入力の強弱感はそのまま活きる。
  if (birdMode) speed *= BIRD_SPEED_MULT;
  const forward = _moveForward.set(-Math.sin(camYaw), 0, -Math.cos(camYaw));
  const right   = _moveRight.set( Math.cos(camYaw), 0, -Math.sin(camYaw));

  let moveX = 0, moveZ = 0, moveY = 0;
  let isMoving = false;

  // Keyboard
  if (keys['w'] || keys['arrowup'])    { moveX += forward.x; moveZ += forward.z; isMoving = true; }
  if (keys['s'] || keys['arrowdown'])  { moveX -= forward.x; moveZ -= forward.z; isMoving = true; }
  if (keys['a'] || keys['arrowleft'])  { moveX -= right.x;   moveZ -= right.z;   isMoving = true; }
  if (keys['d'] || keys['arrowright']) { moveX += right.x;   moveZ += right.z;   isMoving = true; }
  // Mouse keys for camera
  if (keys['q']) { camYaw += dt; }
  if (keys['e']) { camYaw -= dt; }

  // Joystick
  if (joyActive && (Math.abs(joyOx) > 0.1 || Math.abs(joyOz) > 0.1)) {
    moveX += forward.x * (-joyOz) + right.x * joyOx;
    moveZ += forward.z * (-joyOz) + right.z * joyOx;
    isMoving = true;
  }

  // Normalize
  const mLen = Math.sqrt(moveX*moveX + moveZ*moveZ);
  if (mLen > 0) { moveX /= mLen; moveZ /= mLen; }

  // 【2026-07-27・BIRDモード】視界のピッチ(camPitch)を移動方向に反映する。下を向いて
  // 前進すれば潜行、上を向いて前進すれば上昇するようにしたい、というユーザー要望。
  // moveX/moveZは正規化済みのforward/right合成なので、forward・right単位ベクトルとの内積
  // (共に単位ベクトルで直交)で「前後どれだけ」「左右どれだけ」の係数(fAmt/rAmt)を復元
  // できる。前後成分だけをcos(camPitch)で水平方向に縮め、その分をsin(camPitch)で垂直
  // (moveY)に振り分ける。左右ストレイフはロールを付けず従来どおり水平のまま(一般的な
  // フライトカメラの流儀)。ベクトルの大きさ(fAmt²+rAmt²=mLen²=1)は保たれるので、
  // 見た目の速度(speed)は視線の向きによらず一定。
  if (birdMode && mLen > 0) {
    const fAmt = moveX * forward.x + moveZ * forward.z;
    const rAmt = moveX * right.x + moveZ * right.z;
    const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
    moveX = forward.x * cp * fAmt + right.x * rAmt;
    moveZ = forward.z * cp * fAmt + right.z * rAmt;
    moveY = -sp * fAmt; // camPitchが大きい(下向き視点)ほど前進(fAmt>0)で降下
  }

  // Apply movement with collision
  const nx = player.position.x + moveX * speed * dt;
  const nz = player.position.z + moveZ * speed * dt;
  if (!wouldCollide(nx, player.position.z)) player.position.x = nx;
  if (!wouldCollide(player.position.x, nz)) player.position.z = nz;

  // ======= ジャンプ・重力・着地(地形と建物屋根の両方に整合) =======
  const floorY = floorHeightAt(player.position.x, player.position.z, player.position.y);
  // ボタン/Spaceを押している間は高度の上限なく一定速度で上昇し続け、
  // 離すとその場の上向き速度から自然に重力で落下へ移行する。
  // 高度キープ(altLocked、part7.js)がONの間は重力・上昇入力とも無視してその場の高さに静止する。
  // 解除した瞬間はvelY=0のまま「else if (airborne)」に合流し、自然に落下が始まる。
  if (altLocked) {
    velY = 0;
  } else if (birdMode) {
    // 【2026-07-27・BIRDモード】重力・地形追従・接地判定を無視し、(1)視界のピッチに連動した
    // 前後移動分(上のmoveY、下や上を向いて進むことでの潜行/上昇)と(2)上昇(hopHeld)/
    // 下降(birdDescendHeld)ボタンの2系統を合算して高さを直接制御する。常にairborne=true
    // にしておくことで、下のJump pose(空中姿勢)が流用され、歩行アニメーションは出ない。
    // ボタン同士は同時押しで相殺して静止。OFFに戻すと最後のvelYを引き継いで通常の重力
    // 落下(下の「else if (airborne)」)へ自然に合流する。
    airborne = true;
    const buttonV = hopHeld === birdDescendHeld ? 0 : (hopHeld ? BIRD_VSPEED : -BIRD_VSPEED);
    velY = buttonV + moveY * speed;
    player.position.y += velY * dt;
  } else if (hopHeld) {
    velY = RISE_SPEED;
    airborne = true;
    player.position.y += velY * dt;
  } else if (airborne) {
    velY += GRAVITY * dt;
    player.position.y += velY * dt;
    if (velY <= 0 && player.position.y <= floorY) {
      player.position.y = floorY; velY = 0; airborne = false;
    }
  } else {
    if (player.position.y - floorY > 1.5) {
      airborne = true; velY = 0; // 屋根や崖から歩き出た → 落下開始
    } else {
      player.position.y = floorY; // 接地中は床に追従
    }
  }

  // Face movement direction
  if (isMoving) {
    const targetAngle = Math.atan2(moveX, moveZ);
    let diff = targetAngle - player.rotation.y;
    while (diff >  Math.PI) diff -= Math.PI*2;
    while (diff < -Math.PI) diff += Math.PI*2;
    player.rotation.y += diff * 8 * dt;
  }

  // Walk / Run animation — 速度(5=歩き 〜 45=全力疾走)に応じて歩幅の速さ・振幅・前傾を変える
  const runT = Math.max(0, Math.min(1, (speed - 5) / 40)); // 0=歩き, 1=全力疾走
  if (isMoving && !airborne) {
    const cadence  = 6 + runT * 8;    // 歩き:6 → 全力疾走:14(1秒あたりの振り速さ)
    const swingAmp = 0.5 + runT * 0.45; // 歩き:0.5 → 全力疾走:0.95(振り幅)
    walkCycle += dt * cadence;
    const swing = Math.sin(walkCycle) * swingAmp;
    leftArm.rotation.x  =  swing;
    rightArm.rotation.x = -swing;
    leftLeg.rotation.x  = -swing; // 腕と脚は逆位相(右腕+左脚が同時に前へ)
    rightLeg.rotation.x =  swing;
    player.rotation.x = runT * 0.22; // 走るほど前のめりに(yaw=facingは別軸なので向きには影響しない)
  } else if (!airborne) {
    leftArm.rotation.x  = 0;
    rightArm.rotation.x = 0;
    leftLeg.rotation.x  = 0;
    rightLeg.rotation.x = 0;
    player.rotation.x += (0 - player.rotation.x) * Math.min(1, dt * 10); // ゆっくり直立姿勢に戻す
  }

  // Jump pose — 空中では歩行アニメーションの代わりに脚を畳み、上昇/落下で仰け反り/前のめりを付ける
  if (airborne) {
    const jumpT = Math.min(1, Math.abs(velY) / 15.6);
    leftArm.rotation.x  = -0.9 * jumpT;
    rightArm.rotation.x = -0.9 * jumpT;
    leftLeg.rotation.x  =  0.7 * jumpT;
    rightLeg.rotation.x =  0.7 * jumpT;
    player.rotation.x = velY > 0 ? -0.15 * jumpT : 0.1 * jumpT;
  }

  // 【2026-07-27・BIRDモード】翼の羽ばたきアニメーション。移動速度が速いほど速く羽ばたく
  // (静止5Hz相当〜全力12Hz相当)。leftWing/rightWingはビジュアル用の新規メッシュ(part1.js)
  // で、腕とは独立に動かす(表示切替はrefreshCharacterVisibility、part7.js)。
  // 【注】翼の基準姿勢(position/rotation.y,z)は目視確認なしで決めた値のため、実機で見て
  // 羽ばたきの向き・角度が不自然なら振幅・基準角を調整すること。
  if (birdMode) {
    const flapSpeed = 5 + Math.min(7, speed / 8);
    birdFlapCycle += dt * flapSpeed;
    const flap = Math.sin(birdFlapCycle) * 0.5;
    leftWing.rotation.x = flap;
    rightWing.rotation.x = flap; // 鳥は左右対称に羽ばたくため同位相
  }

  // Camera
  updatePlayerCamera();
}

// カメラ更新(三人称/一人称/上空)を切り出した共通関数。
// 【2026-07-27・GPS追従モード追加に伴う抽出】元はexploreOnUpdateの末尾にそのまま書かれていた
// ブロックを、ロジックを一切変えずに関数化しただけ(挙動は完全に同一)。GPS追従モード
// (geoOnUpdate、下記)もWASD自由移動と同じ三人称/一人称/上空カメラを使うための共通化。
function updatePlayerCamera() {
  if (viewMode === 1) {
    // First person
    scene.fog = WORLD_FOG;
    camera.position.set(
      player.position.x + Math.sin(player.rotation.y + Math.PI) * 0.1,
      player.position.y + 1.65,
      player.position.z + Math.cos(player.rotation.y + Math.PI) * 0.1
    );
    camera.rotation.order = 'YXZ';
    // 【2026-07-21修正】以前は camYaw + Math.PI で、スティックの「前進」方向
    // (forward = -sin(camYaw), -cos(camYaw)。三人称カメラの向き・ミニマップの
    // 視界コーン(-camYaw)と同じ基準)とちょうど180°逆向きの景色を映していた。
    // 一人称で前に歩いているつもりが実際は後ずさりし、ミニマップの視界コーンとも
    // 逆を向いて見える不具合(ユーザー報告)の直接の原因。他のカメラ/移動計算と
    // 同じ camYaw そのものを使うよう統一する。
    camera.rotation.y = camYaw;
    camera.rotation.x = -camPitch + 0.3;
  } else if (viewMode === 2) {
    // Overhead / top-down — disable fog so buildings are visible
    scene.fog = null;
    // プレイヤーの標高基準にしないと山岳部で地形がカメラより高くなる
    camera.position.set(player.position.x, player.position.y + 800, player.position.z + 0.001);
    camera.up.set(0, 0, -1);
    camera.lookAt(player.position.x, player.position.y, player.position.z);
    camera.up.set(0, 1, 0); // restore after lookAt
  } else {
    // Third person
    scene.fog = WORLD_FOG;
    const camX = player.position.x + Math.sin(camYaw) * camDist * Math.cos(camPitch);
    const camY = player.position.y + camHeight + camDist * Math.sin(camPitch);
    const camZ = player.position.z + Math.cos(camYaw) * camDist * Math.cos(camPitch);
    const idealCam = _idealCam.set(camX, camY, camZ);
    const safeCam = occlusionCamPos(idealCam, _occTargetPos.set(player.position.x, player.position.y + 1.5, player.position.z));
    camera.position.lerp(safeCam, 0.2);
    camera.lookAt(player.position.x, player.position.y + 1.5, player.position.z);
  }
}

// ======= GPS MODE(モードA): 実際のGPS位置に追従。WASD/スティック入力は無視 =======
// geoAnchorX/Z/Time・geoVelX/Z(part7.jsのonGeoFixが継続更新)から、次のフィックスが来るまでの
// 間も推定速度で外挿し続ける(dead reckoning)ことで、フィックスの瞬間だけワープしてあとは
// 静止する、という動きではなく連続して歩いているように見せる(ユーザー要望・2026-07-27)。
// 外挿した点へは位置は指数平滑で追従、向きは角度差の平滑回頭でなめらかに追いつかせる。
// ユーザー確認済みの設計により、GPS誤差での建物めり込みを許容し水平方向の衝突判定
// (wouldCollide)はここでは行わない。ジャンプ・BIRDモード・高度キープ等の操作系はこの
// モードでは対象外(実際に歩くモードのため)。
const GEO_POS_SMOOTH = 6;  // 位置追従の平滑化速度(1/秒。大きいほど目標点に速く寄る)
// 【2026-07-27・向きをスマホのコンパスに変更】コンパスは高頻度・連続的に取れるため、
// GPS移動ベクトル頼りだった頃より応答を上げても(値自体が安定しているので)ジッターにならない。
// 4→8に引き上げ、実際にスマホを振り向けた動きへの追従をきびきびさせる。
const GEO_YAW_SMOOTH = 8;  // 向き追従の平滑化速度(1/秒)
const GEO_CAM_RETURN_SMOOTH = 6; // 指を離した後、カメラがplayer.rotation.yへ戻る速度(1/秒)
function geoOnUpdate(dt) {
  // 直近フィックス(geoAnchor)から、推定速度(geoVel)で経過時間ぶん外挿した点を目標にする。
  // GEO_EXTRAPOLATE_MAXを超えたら外挿をやめてその場で待機させる(信号ロスト時の暴走防止)。
  let targetX = geoAnchorX, targetZ = geoAnchorZ;
  if (geoAnchorTime !== null) {
    const elapsed = Math.min((performance.now() - geoAnchorTime) / 1000, GEO_EXTRAPOLATE_MAX);
    targetX = geoAnchorX + geoVelX * elapsed;
    targetZ = geoAnchorZ + geoVelZ * elapsed;
  }
  const dx = targetX - player.position.x, dz = targetZ - player.position.z;
  player.position.x += dx * Math.min(1, dt * GEO_POS_SMOOTH);
  player.position.z += dz * Math.min(1, dt * GEO_POS_SMOOTH);
  const isMoving = Math.hypot(geoVelX, geoVelZ) > 0.15 || Math.hypot(dx, dz) > 0.05;

  // 向き: スマホのコンパス(geoCompassHeading、part7.js)が新しければ最優先で使う。
  // 取れていない/古い(GEO_COMPASS_STALE_MS超)場合はGPS移動ベクトル推定(geoTargetYaw)に
  // フォールバックする。explore同様の角度差平滑で回頭する(体の向き=実際に歩いている方向)。
  let effectiveYaw = geoTargetYaw;
  if (geoCompassHeading !== null && geoCompassLastUpdate !== null &&
      (performance.now() - geoCompassLastUpdate) < GEO_COMPASS_STALE_MS) {
    // GEO_COMPASS_OFFSET_DEG(part7.js): 実機で進行方向と逆向きになる報告があったための補正。
    const hRad = (geoCompassHeading + GEO_COMPASS_OFFSET_DEG) * Math.PI / 180;
    // xzToLatLon/latLonToXZの座標系(+X=東、+Z=南)に合わせた北基準の向きベクトルから
    // atan2(dx,dz)で角度を出す(GPS移動ベクトル推定・WASD向き計算と同じ基準に揃える)。
    effectiveYaw = Math.atan2(Math.sin(hRad), -Math.cos(hRad));
  }
  if (effectiveYaw !== null) {
    let diff = effectiveYaw - player.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    player.rotation.y += diff * GEO_YAW_SMOOTH * dt;
  }

  // 【2026-07-27・ユーザー要望】カメラ(camYaw)は今まで毎フレームplayer.rotation.yへ強制
  // 一致させていたため、explore同様のドラッグ操作(part7.jsのmousemove/touchmoveハンドラが
  // 直接camYawを書き換える)がその場で打ち消され、指で視界を引っ張ることができなかった。
  // ドラッグ中(mouseDown、または右側タッチのcamTouchIdが有効)はcamYawに一切触れず
  // ハンドラの更新をそのまま反映させ、指を離した(ドラッグしていない)間だけ体の向き
  // (=進行方向/コンパス)へなめらかに戻す。
  const geoDragging = mouseDown || camTouchId !== null;
  if (!geoDragging) {
    let camDiff = player.rotation.y - camYaw;
    while (camDiff > Math.PI) camDiff -= Math.PI * 2;
    while (camDiff < -Math.PI) camDiff += Math.PI * 2;
    camYaw += camDiff * GEO_CAM_RETURN_SMOOTH * dt;
  }

  // 床・重力(ジャンプ/BIRD/高度キープは対象外。歩行中に段差から落ちる程度は自然に追従させる)
  const floorY = floorHeightAt(player.position.x, player.position.z, player.position.y);
  if (airborne) {
    velY += GRAVITY * dt;
    player.position.y += velY * dt;
    if (velY <= 0 && player.position.y <= floorY) { player.position.y = floorY; velY = 0; airborne = false; }
  } else if (player.position.y - floorY > 1.5) {
    airborne = true; velY = 0;
  } else {
    player.position.y = floorY;
  }

  // 歩行アニメーション: 実際の歩行を模した固定ペース(WASDのrunT/speed連動アニメは使わない)
  if (isMoving && !airborne) {
    walkCycle += dt * 6;
    const swing = Math.sin(walkCycle) * 0.5;
    leftArm.rotation.x = swing; rightArm.rotation.x = -swing;
    leftLeg.rotation.x = -swing; rightLeg.rotation.x = swing;
  } else if (!airborne) {
    leftArm.rotation.x = 0; rightArm.rotation.x = 0;
    leftLeg.rotation.x = 0; rightLeg.rotation.x = 0;
  }
  player.rotation.x += (0 - player.rotation.x) * Math.min(1, dt * 10);

  updatePlayerCamera();
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t  = clock.getElapsedTime();

  // ゲームプレイモード固有の処理(現状はexplore=3D探索の移動・ジャンプ・カメラ)。
  // 元は同じ内容がここに直接書かれていたのと完全に同じ順序・タイミングで呼ばれる。
  // 以降のstation labels・カメラ追従処理はカメラが確定済みであることに依存するため、
  // この呼び出しは他の処理より先に行う必要がある。
  if (window.ModeRegistry) ModeRegistry.update(dt);

  // Station labels: billboard + ring spin
  for (const sl of stationLabels) {
    if (sl.type === 'label') {
      sl.mesh.quaternion.copy(camera.quaternion);
    } else if (sl.type === 'ring') {
      sl.mesh.rotation.y = t * 0.8;
      sl.mesh.rotation.x = Math.sin(t * 0.5) * 0.3;
    }
  }

  // Dynamic chunk streaming — generates buildings around player as they explore
  updateChunks();
  processChunkQueue(); // フレーム分割: 1チャンク/フレーム
  // 道路も建物と同じく、タイル到着時に一度並べた「近い順」がプレイヤーの移動で古くなる。
  // pendingRoadMeshesは処理済み分をprocessRoadMeshQueue側でsplice(0,i)して毎回0番始まりに
  // 保っているので、fromIdx=0でまるごと並べ直せばよい(pendingBuildingsのような
  // インデックスカーソル管理が不要な分、建物より単純)。
  _roadSortFrame++;
  if (_roadSortFrame % 30 === 0) {
    sortNewEntriesByDistanceToPlayer(pendingRoadMeshes, 0, r => ({ x: (r.x1 + r.x2) / 2, z: (r.z1 + r.z2) / 2 }));
  }
  processRoadMeshQueue(); // 道路メッシュもフレーム分割(密集タイル到着時のフリーズ防止)
  // タイル取得分の建物もフレーム分割(20棟/フレーム)で生成。
  // 【重要】以前はここでNEAR地形の準備状況を一切見ていなかった。チャンク生成側
  // (processChunkQueue/chunkNearTerrainReady)だけをゲートしても、実際の建物の大半は
  // OSMタイルのポリゴンから来るこちらの経路で生成されるため、浮き/埋まりが直りきって
  // いなかった。同じ判定をここにも入れ、NEARがまだその位置を覆っていなければこのフレームは
  // ここで足踏みする(同じ建物から次フレームで再判定。手前で止めるだけなのでコストは低い)。
  // 【重要】以前はここでNEAR未準備の建物に当たった時点でbreakしており、キューが
  // OSM出現順(=場所とは無関係)のFIFOだったため、たまたま先頭付近にNEAR未到達の
  // 建物が1つあるだけで、後続の「もう準備が整っている」他エリアの建物まで全部
  // 足止めされていた。これが移動速度に読み込みが追いつかない主因の一つ。
  // → 未準備の建物は諦めずキュー末尾へ回して次を試す(他が足止めされないように)。
  // 固定20棟/フレームだと、密集タイルが届いた直後にバックログが溜まりやすい。
  // 未処理分(バックログ)が多いほど今フレームの処理数を増やす可変バジェットにし、
  // 通常時(バックログ小)はコマ落ちさせない20棟のまま、山になった時だけ追いつく。
  // 未処理分(pendingBuildingIdx以降)だけを対象に、プレイヤー現在地への近い順で並べ直す。
  // 毎フレームやると要素数が多い時にソート自体が重くなるため、~30フレーム(0.5秒)おきに
  // 留める(その程度の遅延なら「常に一番近い建物から出る」体感には十分)。
  _buildingSortFrame++;
  if (_buildingSortFrame % 30 === 0) {
    // 【2026-07-20・タブクラッシュ調査】pendingBuildingIdxは処理済み分を「読み飛ばす」
    // カーソルなだけで、配列からは一切取り除いていなかった。配列全体が空になってidx===
    // lengthになった時だけ丸ごとpendingBuildings.length=0にリセットされる(下の488行目)が、
    // タイルを取得し続ける通常のプレイでは新規建物が常に末尾へ積まれ続けるため、この
    // リセットはほぼ発生しない。結果、処理済みの建物オブジェクトが配列の先頭に無期限に
    // 溜まり続け、実機ログでpendingBuildings.lengthが約20分のプレイで15,000→55万件超まで
    // 単調増加し続けることを確認した(GPU/JSヒープを圧迫し続けるタブクラッシュの主因と判断)。
    // 道路メッシュキュー(pendingRoadMeshes)は既にsplice(0,i)で処理済み分を都度切り捨てて
    // いる(processRoadMeshQueue参照)のと同じ考え方で、処理済みの先頭側がある程度溜まったら
    // 配列自体を縮める。
    if (pendingBuildingIdx > 5000) {
      pendingBuildings.splice(0, pendingBuildingIdx);
      pendingBuildingIdx = 0;
    }
    sortNewEntriesByDistanceToPlayer(pendingBuildings, pendingBuildingIdx, b => ({ x: b.x, z: b.z }));
  }
  const _buildBacklog = pendingBuildings.length - pendingBuildingIdx;
  // 【重要・2026-07-15】東京駅のような超高密度エリアはバックログが数万件に達し、
  // 上限80のままだと1棟あたりが軽い場所でも実測時間(下の8ms)に達する前に件数上限で
  // 頭打ちになり、生成が体感で非常に遅くなっていた。件数上限自体を引き上げても、
  // 8msの実測時間打ち切りが依然として最終的な安全弁(香港・NY等の重いメガシティで
  // 1フレームが暴走するのを防ぐ)として効くため、上限を160に緩めてスループットを上げる。
  // 【2026-07-16】起動・ジャンプ直後(=リロード後)の30秒間は「初期ラッシュ」として
  // 生成予算を大幅に引き上げ、体感の待ち時間を縮める(その間のFPS低下は許容)。
  // 30秒過ぎたら従来予算に戻り、プレイ中のフレームレートは従来どおり守られる。
  // 起動後30秒の初期ラッシュに加え、現在地タイルの描写が未完了の間もラッシュ扱いにして
  // 「立っている場所」を常に最優先で仕上げる(part8.js checkCurrentTileRush参照)
  checkCurrentTileRush();
  const _rush = performance.now() < 30000 || _curTileRush;
  let _buildBudget = Math.min(_rush ? 400 : 160, 20 + Math.floor(_buildBacklog / 20));
  // 【重要・2026-07-15】生成順序は地形→道路→建物のはずなのに、道路(pendingRoadMeshes)が
  // 固定6ms/フレームだった一方こちらはバックログに応じて最大80棟/フレームまで伸びる
  // 可変制だったため、混雑時は建物の方が道路より速く追いつき、道路だけ取り残されて
  // 「道路の拡張だけ止まって見える」逆転が起きていた(道路側は上のprocessRoadMeshQueue
  // で同様にバックログ応じた可変予算にして底上げ済み)。それでも道路が大きく詰まっている
  // 間は、建物側の予算をさらに絞って道路に追いつく時間を確保する(0にはしない — 道路が
  // 疎な田舎道沿いの孤立した建物などが永久に生成されなくなるのを避けるため)。
  // 【2026-07-21・Fable5診断】以前はpendingRoadMeshes全体(プレイヤーから遠い場所の
  // バックログも含む)の件数だけでこのゲートを判定していたため、「地形→道路→建物」の
  // 優先順は本来同じエリア内でしか意味が無いのに、プレイヤーから遠く離れた場所の道路
  // バックログが原因で足元の建物生成まで絞られてしまっていた(実機計測: roadBacklogGate=552
  // で常時ゲートが掛かりっぱなしだったのに対し、その大半は先読み分の遠方道路だったと
  // 推定される)。pendingRoadMeshesは30フレーム毎にプレイヤーへの近い順でソート済み
  // (sortNewEntriesByDistanceToPlayer参照)なので、先頭から順に800m以内かどうかだけを
  // 数える。81件を超えた時点、または先頭300件を見た時点で打ち切り(全件走査を避ける。
  // ソートは0.5秒毎の再計算なので多少の誤差は許容)。
  let _roadBacklogForGate = 0;
  {
    const _NEARBY_ROAD_R2 = 800 * 800;
    const _scanN = Math.min(pendingRoadMeshes.length, 300);
    for (let i = 0; i < _scanN; i++) {
      const r = pendingRoadMeshes[i];
      const rx = (r.x1 + r.x2) / 2, rz = (r.z1 + r.z2) / 2;
      const dx = rx - player.position.x, dz = rz - player.position.z;
      if (dx * dx + dz * dz <= _NEARBY_ROAD_R2) _roadBacklogForGate++;
      if (_roadBacklogForGate > 80) break;
    }
  }
  // 初期ラッシュ中は道路優先の絞りも緩める(5だと数万件の建物バックログが捌けない)
  if (_roadBacklogForGate > 80) _buildBudget = Math.min(_buildBudget, _rush ? 40 : 5);
  // 【重要】件数ベースの予算だけだと、1棟あたりのコストが場所によって大きく違う場合に
  // 対応できない(香港・ニューヨークのような超高密度メガシティは1棟の生成コスト自体が
  // 伊勢原基準より重く、実機検証で「1フレームが暴走してタブごと固まって見える」不具合が
  // 確認された)。件数の上限に加えて実測時間(8ms)でも早期に打ち切り、残りは次フレームへ
  // 回すことで、どんなに1棟が重くても1フレームの処理時間には必ず天井を設ける。
  const _buildFrameDeadline = performance.now() + (_rush ? 14 : 8); // 初期ラッシュ中は時間予算も拡大
  // 【2026-07-21・ユーザー要望】診断用: このフレームの予算スナップショットを保存
  // (定期ログで「予算自体が絞られているのか」を見えるようにする)。
  _lastBuildBudget = _buildBudget;
  _lastRoadBacklogForGate = _roadBacklogForGate;
  _lastCurTileRush = _curTileRush;
  for (let n = 0; n < _buildBudget && pendingBuildingIdx < pendingBuildings.length; n++) {
    if (n > 0 && performance.now() > _buildFrameDeadline) break; // 時間切れ: 残りは次フレームへ
    const b = pendingBuildings[pendingBuildingIdx++];
    // 遠景最適化: BUILDING_GEN_DIST(part1.js)より遠い実建物はまだ生成しない。
    // 【重要】ここでpendingBuildingsの末尾へ戻すと、遠方の建物が溜まるほど「戻すだけの
    // 空回り」が積み重なる(チャンク未準備の待ちと違い、遠い建物はプレイヤーが
    // 戻らない限り一生近づかない可能性があるため)。dormantBuildingsという別の待機列へ
    // 逃がし、reactivateNearbyDormantBuildingsが低頻度で接近を検知して戻す。
    if (b.real) {
      const bdx = b.x - player.position.x, bdz = b.z - player.position.z;
      if (bdx * bdx + bdz * bdz > BUILDING_GEN_DIST_REAL * BUILDING_GEN_DIST_REAL) {
        dormantAdd(b);
        _bgDormant++;
        continue;
      }
      // 【2026-07-16】描画済み建物の総数上限(PERF.bMax)。密集地では距離制限だけだと
      // 数万棟に達しGPUメモリが際限なく積み上がる(浮上クラッシュの真因)。上限到達分は
      // dormantへ退避し、移動でunloadFarBuildingsが枠を空けたら近い順に復帰する。
      if (buildingRecords.length >= PERF.bMax) {
        dormantAdd(b);
        _bgDormant++;
        continue;
      }
    }
    const bcx = Math.floor(b.x / CHUNK_SIZE), bcz = Math.floor(b.z / CHUNK_SIZE);
    // 【2026-07-21・Fable5診断(b)】以前はここで「ダメなら末尾へpush」を1件ずつ繰り返しており、
    // 密集地で地形NEARの網羅が追いつかない間は同じ建物群が0.5秒毎に先頭付近へ戻ってきては
    // また末尾へ戻される、というタイトループで生成予算の過半(実機計測56%)を空費していた
    // (part1.js冒頭のコメント参照)。チャンク単位の隔離キューへ退避し、低頻度スキャナ
    // (scanGateWaitQueues)がキー単位でreadyを判定してからまとめて戻す方式に変更。
    if (!IS_MEIJI && !chunkNearTerrainReady(bcx, bcz)) {
      chunkWaitAdd(bcx + ',' + bcz, b);
      _bgRequeued++;
      continue;
    }
    // 【重要・2026-07-16】実OSM建物(b.real)はisOnRoadチェックを免除する。isOnRoadは
    // 建物の外接円半径(halfDiag=対角線の半分)で道路中心線との距離を見るため、
    // 60m×40mの商業ビルならhalfDiag≈36m — 中心から36m+道路半幅以内に道路が1本でも
    // あれば「道路上」と判定される。八重洲・京橋のような大型ビルが道路に四方を囲まれた
    // 街区では大きい実建物がほぼ全て黙って破棄され、しかもknownBuildingGridには
    // 「ここに実建物がある」と登録済みのため手続き生成の補完もブロックされ、
    // 「大きいビルだけが消えて空き地になる」「消える場所が毎回同じ(決定論的)」という
    // 症状になっていた(実機診断: タイルはloaded・count検証済みなのに空き地、で確定)。
    // 実建物は測量データ由来で現実に道路上には建っていないので、このチェック自体が不要。
    // (手続き生成の建物・樹木に対するisOnRoadは従来どおり維持)
    // 【2026-07-16】順序担保(実建物版): 周囲64mがかかる全タイルの道路確定を待つ
    // (part8.js osmTilesReadyAround参照。タイル境界付近で隣タイルの道路が後から届き、
    // 建物が道路に被るレースの対策)。地形待ちと同じ_tries機構で、200回試しても
    // 揃わなければ(隣タイルが4回失敗で諦め扱いになった場合など)待たずに生成する。
    if (b.real && !osmTilesReadyAround(b.x, b.z, 64)) {
      // 【2026-07-21・Fable5診断(b)】チャンク地形待ちと同じ理由で隔離キューへ。キーは建物自身の
      // 所属タイル(周辺64mの判定はこのタイル境界付近でしか変わらないため、代表点判定で十分)。
      tileWaitAdd(Math.floor(b.x / OSM_TILE_M) + ',' + Math.floor(b.z / OSM_TILE_M), b);
      _bgRequeued++;
      continue;
    }
    // 実建物はゲーム側の広い道路・線路リボンに食い込む分だけ寸法を縮めてから生成する
    // (part2.js fitRealBuildingToRoads参照。道路レコード登録はデータ到着時に同期で済んで
    // いるので、描画時点では周囲のリボン幅が判明している)。1回だけ計算して結果を保持。
    if (b.real && !b._fit) {
      const _f = fitRealBuildingToRoads(b.x, b.z, b.w, b.d, b.rot);
      if (_f.drop) continue; // 縮小しても線路に被る建物(線路またぎ)は生成しない
      b.w = _f.w; b.d = _f.d; b._fit = 1;
    }
    if (b.real || !isOnRoad(b.x, b.z, b.w, b.d)) addBuilding(b.x, b.z, b.w, b.d, b.h, b.style, b.real, b.rot);
    _bgGenerated++;
  }
  if (pendingBuildingIdx > 0 && pendingBuildingIdx === pendingBuildings.length) {
    pendingBuildings.length = 0; pendingBuildingIdx = 0;
  }
  // 実OSM建物が距離に関係なく無限に溜まり続けメモリ・描画負荷が際限なく増える
  // (長時間プレイでの重量化→クラッシュ)のを防ぐため、遠方の建物を解放する
  unloadFarBuildings();
  reactivateNearbyDormantBuildings(); // 逆に、近づいた遠景建物は生成キューへ復帰させる
  evictFarDormant(); // 二度と戻らない遠方のdormant記述子を捨てる(part1.js、無人長距離走行対策)
  scanGateWaitQueues(); // 【2026-07-21・Fable5診断(b)】ゲート待ち隔離キューの低頻度スキャン
  // (2026-07-16: 高度LOD(updateAltitudeLOD)は撤去 — 40m/300mまで絞ってもクラッシュ防止に
  //  効かないことが実証され、上空の「スカスカ感」の害だけが残ったため。クラッシュの実対策は
  //  建物総数キャップ(PERF.bMax)+細街路メッシュ距離制限で達成済み)
  // 道路・線路も同様に、遠方のものはGPUメッシュだけ解放する(記録データは残す)
  unloadFarRoads();
  evictFarRoads(); // 遠方の道路レコード自体を捨てる(part1.js、roadRecordsの無制限増加対策)
  // 公園・水面・田畑・キャンパスの面メッシュも同じ方式(遠方GPU解放/再接近で再構築)。
  // 【2026-07-17】以前はこれだけ一度作ったら二度と解放されなかった(CODE_REVIEW_20260717 P8)。
  unloadFarAreaPolys();
  // Tile-based OSM fetch — loads roads/buildings for newly entered areas
  checkOSMTiles();
  // 遠景標高グリッドをプレイヤーに追従(遠くへジャンプしても実地形・標高が出る)
  checkWideTerrain();
  checkNearTerrain(); // プレイヤー周辺の高解像度グリッドも追従させる
  checkAddressDisplay(); // 現在地の住所表示(市区町村+町名)を移動に応じて更新

  // 山の森(プレイヤー周囲だけ・移動で作り直し)
  updateForest();
  // デバッグ: タイル読み込み状況オーバーレイ(オフ中は内部で即return、コストなし)
  updateDebugTileOverlay();
  // メモリ計測(🩺のON/OFFに関係なく常時。updateMemDiag参照)
  updateMemDiag();

  // 空・星・遠景地形をカメラ/プレイヤーに追従させる
  // (固定のままだと移動やマップジャンプで far クリップ外に出て「空が消える」)
  skyMesh.position.copy(camera.position);
  starMesh.position.copy(camera.position);
  // 海面もカメラ追従(高さは海面固定)。テクスチャをスクロールしてさざ波を演出
  if (seaMesh) {
    seaMesh.position.x = camera.position.x;
    seaMesh.position.z = camera.position.z;
    const wt = seaMesh.material.map;
    wt.offset.x = (t * 0.012) % 1;
    wt.offset.y = (t * 0.008) % 1;
    // キャラが完全に水没(頭まで海面下)したら水中エフェクトを出す
    const submerged = (player.position.y + 1.8) < SEA_Y;
    if (submerged !== _wasSubmerged) {
      if (waterOverlay) waterOverlay.classList.toggle('active', submerged);
      _wasSubmerged = submerged;
    }
  }
  updateFarMesh(); // 200mグリッドをまたいだ時だけ再サンプリング(それ以外は即return)

  renderer.render(scene, camera);
  drawMinimap();
  updateGPS(t);
}

if (window.ModeRegistry) {
  // 3D探索を最初のゲームプレイモードとして登録する。
  // 移動・ジャンプ・歩行アニメーション・カメラの実処理は exploreOnUpdate(上で定義)に
  // 分離済み。将来のRPG/アクション等のモードは、同じ枠組みで別のonUpdateを登録すればよい。
  ModeRegistry.registerMode({ id: 'explore', label: '3D探索', onUpdate: exploreOnUpdate });
  // 【2026-07-27・GPS追従モード(モードA)】geoBtn(part7.js)のstartGeoFollow/stopGeoFollowが
  // switchMode('geo')/switchMode('explore')でこの2モードを排他的に切り替える。
  ModeRegistry.registerMode({ id: 'geo', label: 'GPS追従', onUpdate: geoOnUpdate });
  ModeRegistry.switchMode('explore');
}

animate();

// ======= RESIZE =======
window.addEventListener('resize', () => {
  renderer.setPixelRatio(gfxPixelRatio()); // ウィンドウが大きくなった時にドローイングバッファが青天井にならないよう毎回計算し直す(part1.js GFX参照)
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ======= 画面回転時のHUDボタン位置ズレ対策 =======
// 【2026-07-23追加】ユーザー報告: スマホを横向きにすると、ジャンプボタン等の
// 見た目の位置とタップが反応する位置がズレて押せなくなる。position:fixedと
// env(safe-area-inset-*)を組み合わせた要素で、回転直後は表示だけ新しい向きに
// 描画され、実際のタップ判定(ヒットテスト)が回転前のレイアウトのまま残る
// 既知のブラウザ側の不具合(特にiOS Safari)が原因と考えられる。
// 【2026-07-23修正】当初 document.body.style.display='none'→'' で強制リフロー
// させていたが、起動直後にも resize イベントが発生することがあり、body全体を
// 一瞬非表示にするとWebGL(canvas)の描画が巻き込まれてフリーズする不具合が
// 発生した。offsetHeightを読むだけでも同期的にレイアウト再計算は強制されるため、
// displayの切替は行わない安全な方式に変更する。
function forceHudReflow() {
  void document.body.offsetHeight; // 読むだけでレイアウトを強制再計算させる(表示は一切変更しない)
}
window.addEventListener('orientationchange', () => setTimeout(forceHudReflow, 300));

// ======= クラッシュ・タブ強制終了からの再開用に現在地を定期保存 =======
// 【2026-07-24追加】ユーザー要望: クラッシュした時に初期位置(現在地GPS/伊勢原)へ
// 飛ばされてしまうのを直したい。10秒ごとに現在地をlocalStorage(iseharaLastPos)へ
// 上書き保存しておき、次回起動時(明示的なモード切替・遠方ジャンプの再開マーカーが
// 無ければ)part6.js loadOSM()がここから再開する(part1.js saveLastPos/readLastPos参照)。
// 初回のsaveLastPosはプレイヤーの初期位置が確定した後(起動ブートストラップIIFE完了後)に
// 呼ばれるべきだが、setIntervalは10秒後が初回発火なのでその頃には確実に確定している。
setInterval(saveLastPos, 10000);

// ======= 起動ブートストラップ(元 part6.js 末尾から移動) =======
// 【重要】このIIFEはxzToLatLon(part7.js定義)などを同期的に呼ぶため、
// 9ファイルすべての読み込みが終わった後(=このpart9.jsの実行時点)で初めて安全に実行できる。
// part6.jsに置いたままだと、part7.js〜part9.jsがまだ読み込まれる前にReferenceErrorで停止していた。
// Load terrain first, then place OSM world on top
// 明治モードは迅速測図の土地利用データを先に読む(チャンク生成が依存)
(async () => {
  const startLocP = getStartLocation(); // 位置情報の取得を本編ロードと並行で開始
  // モード切替リロード(江戸↔現実など)や遠方ジャンプ後の再開では切替/ジャンプ前の位置に戻す。
  // その時は現在地ジャンプしないし、これから行う伊勢原の初期地形取得も無駄になる(後述)。
  let isModeSwitch = false;
  // 【2026-07-18】遠方ジャンプ(300km超)による再開かどうかを、破壊読み(consumeResumePos)
  // する前に先読みしておく。理由は下のloadNearTerrain(0,0)呼び分けを参照。
  // 【2026-07-24】iseharaResumePos(明示的な再開)が無い場合、iseharaLastPos(クラッシュ・
  // タブ強制終了からの再開用に定期保存された最終位置。part1.js readLastPos/saveLastPos参照)
  // も同じ扱いにする — これが無いと、loadOSM側はiseharaLastPosから正しい位置へ復帰するのに、
  // この後の「通常起動時だけ位置情報へジャンプする」処理がそれを知らずに上書きしてしまう。
  let resumeFarJump = false;
  try {
    const s = localStorage.getItem('iseharaResumePos') || localStorage.getItem('iseharaLastPos');
    if (s) {
      isModeSwitch = true;
      const p = JSON.parse(s);
      if (typeof p.lat === 'number' && typeof p.lon === 'number') {
        const d = Math.hypot((p.lon - MID_LON) * SCALE * COS_LAT, (p.lat - MID_LAT) * SCALE);
        resumeFarJump = d > RECENTER_DIST_M; // jumpToLatLon/recenterForResumeIfFarと同じ式・同じ閾値
      }
    }
  } catch (e) {}
  // 【重要】OSMデータの実際の取得・生成はもうここでは行わない — loadOSM()(part6.js)は
  // プレイヤーの初期位置決定と国コードの早期取得だけを行い、道路・建物はpart8.jsの
  // タイル取得システム(checkOSMTiles)がinitialWorldLoaded=true後に周辺タイルとして
  // 取りに行く(伊勢原も他地域と同じ経路)。そのため地形取得と並行するfetchOSMData()の
  // 事前投げは不要になった。
  // 伊勢原本体(原点)のNEAR地形を先に取得しておく。モード切替(江戸↔現実など、伊勢原に
  // 留まったままの再開)ではisModeSwitchがtrueでも省略できない — この時点ではまだ
  // 「モード切替」と「遠方ジャンプ」を区別できないため。
  // 【2026-07-18】ただし遠方ジャンプ(resumeFarJump)だけは先読みで区別できるようになった。
  // 遠方ジャンプの場合、原点はどのみちこの直後のloadOSM()内でジャンプ先へ付け替わる
  // (recenterForResumeIfFar)ため、ここで伊勢原原点(0,0)のNEAR地形を取りに行くのは
  // 丸ごと無駄になる(標高APIの往復時間ぶん「マップを読み込み中」が無駄に延びていた)。
  if (!resumeFarJump) await loadNearTerrain(0, 0);
  if (USES_MEIJI_LANDUSE) await loadMeijiLanduse();
  // 【2026-07-25】江戸期実データ(街道・町家領域)は生成をブロックしない補強シグナルなので
  // awaitせず裏で読み込む(未読込中はedoRealDataReady=falseで従来ロジックにフォールバックする)。
  if (USES_MEIJI_LANDUSE) loadEdoRealData();
  // モード切替/遠方ジャンプの再開時は、loadOSM()内部で再開先へ原点を付け替え(recenterOrigin)、
  // regionBaseReadyがfalseに戻るため、下のloadNearTerrainで新しい地域の高度基準が確定し直される。
  await loadOSM();
  // 【2026-07-18】以前はisModeSwitchでも無条件でstartLocP(位置情報, 最大8秒)をawaitして
  // いたが、isModeSwitch時はその結果(loc)を使わない(下のjumpToLatLonを呼ばない)ため、
  // ここでの待ちは完全に無駄だった。建物生成はNEAR地形到達待ちのゲート(chunkNearTerrainReady)
  // があるため、この無駄な待ちがジャンプ先へのNEAR/WIDE地形取得の開始を遅らせ、
  // 「マップを読み込み中」の間ずっと建物が生成されない体感を悪化させていた。
  // 通常起動(isModeSwitchでない)時だけ位置情報を待って初期位置へ移動する。
  if (!isModeSwitch) {
    const loc = await startLocP;
    jumpToLatLon(loc.lat, loc.lon);
  }
  // 最終的なプレイヤー位置を中心に、NEAR(周辺・高解像度)とFAR(広域・低解像度)を両方取得
  loadNearTerrain(player.position.x, player.position.z);
  loadWideTerrain(player.position.x, player.position.z);

  // 【2026-07-27・GPS追従モードの遠方ジャンプ再開】startGeoFollow(part7.js)が、遠方
  // (300km超)ジャンプでのlocation.reloadを検知した時だけ立てておくフラグ。ここまでの
  // resume処理(loadOSM内recenterOrigin)で既にジャンプ先へ原点が付け替わっているため、
  // 起動直後にstartGeoFollowを呼び直せば今度は近距離ジャンプ扱いになりreloadは起きず、
  // 継続追従(watchPosition)がそのまま定着する。
  let resumeGeoFollow = false;
  try { resumeGeoFollow = localStorage.getItem('iseharaResumeGeoFollow') === '1'; } catch (e) {}
  if (resumeGeoFollow) {
    try { localStorage.removeItem('iseharaResumeGeoFollow'); } catch (e) {}
    if (typeof startGeoFollow === 'function') startGeoFollow();
  }
})();
