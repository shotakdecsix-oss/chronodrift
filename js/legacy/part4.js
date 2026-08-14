/**
 * legacy/part4.js — index.html の巨大インラインスクリプトを行範囲のまま機械的に切り出した
 * ファイル(4/9)。part3.js の続き。詳細は part1.js 冒頭のコメント参照。
 */
// ======= 道路沿いの小物自動配置 =======
// すべてインスタンスプールへの追記なのでメッシュ・マテリアルは増えない
function decorateRoad(x1, z1, x2, z2, type, w, rec) {
  // 【2026-07-20】未舗装(農道・山道等。part8.js参照)は下のminor判定に含まれず、
  // else節(幹線=secondary以上)に落ちてガードレール・信号機が付いてしまっていた
  // (舗装/未舗装の分岐導入前は全て'road'扱いでminor側に入っていたための取りこぼし)。
  // 未舗装路には自販機はもちろんガードレール・信号機も実態としてまず無いため、
  // 装飾なしのまま素通りさせる。
  if (type === 'water' || type === 'railway' || type === 'unpaved') return;
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 18) return;
  const nx = dx / len, nz = dz / len, px = -nz, pz = nx;
  const ry = Math.atan2(-nz, nx); // boxのX軸を道路方向に向ける回転
  if (IS_MEIJI) {
    // 明治: 街道の並木と道祖神(石)のみ。電柱・自販機・信号・ガードレール・看板は存在しない
    for (let s = 20; s < len - 10; s += 45 + Math.random() * 20) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const tx = x1 + nx * s + px * side * (w / 2 + 2.2);
      const tz = z1 + nz * s + pz * side * (w / 2 + 2.2);
      addTree(tx, tz, 1.0 + Math.random() * 0.6);
    }
    if (Math.random() < 0.08) {
      const t = Math.random();
      const sx = x1 + dx * t + px * (w / 2 + 1);
      const sz = z1 + dz * t + pz * (w / 2 + 1);
      // 【2026-08-02】マップジャンプ直後浮き/埋まり対策(下のsignalP/poleP/lampPと同じ理由)
      const idx = poolAdd(signalP, sx, getGroundY(sx, sz) + 0.4, sz, Math.random() * 3, 0.5, 1.6, 0.9); // 道祖神
      trackResnapInstance(signalP, idx, sx, sz, 0.4);
    }
    return;
  }
  const minor = (type === 'road' || type === 'tertiary');
  if (minor) {
    // 電柱・電線は撤去済み(2026-07-15。ただの装飾でリソースの無駄という判断。
    // 経緯はpart2.js冒頭のコメント参照)。
    // 【2026-07-28・ユーザー要望で撤去】自販機。vendPプール自体はpart2.jsに残しているが
    // (signBoardP撤去時と同じ方針)、poolAdd呼び出しをやめたので以降生成されない。
  } else {
    // 【2026-07-28・ユーザー要望で撤去】ガードレール。guardPプール自体はpart2.jsに残している
    // (signBoardP撤去時と同じ方針)が、poolAdd呼び出しをやめたので以降生成されない。
    // 信号機(長い区間にたまに。江戸モードでは出さない)
    if (PROP_SIGNALS && len > 60 && Math.random() < 0.1) {
      const sx = x1 + dx * 0.5 + px * (w / 2 + 0.8), sz = z1 + dz * 0.5 + pz * (w / 2 + 0.8);
      const gy = getGroundY(sx, sz);
      // 【2026-08-02・ユーザー報告「マップジャンプ後に信号機が空中に浮かんでいる」】
      // ジャンプ直後は新しい地点のNEAR地形がまだ届いておらず、getGroundYが古い地域や
      // 0m基準にフォールバックする(part6.js terrainY)。建物・道路・森の木は既にNEAR地形
      // 更新時の再スナップ対象になっている(part6.js loadNearTerrain内)が、この道路小物
      // (信号機・電柱・街灯)は個体レコードを持たずInstancedMeshプールのみのため対象外
      // だった。生成位置をtrackResnapInstance(part1.js)に登録し、NEAR地形が更新される
      // たびY座標を再計算させる(信号機・街灯の座標はsx-px*1.2等でpoleと少しずれるため、
      // 個別にtxs/tzsとして登録する)。
      const px1 = sx - px * 1.2, pz1 = sz - pz * 1.2;
      const idxPole = poolAdd(poleP, sx, gy + 3, sz, 0, 0.8, 0.72, 0.8);
      trackResnapInstance(poleP, idxPole, sx, sz, 3);
      const idxSignal = poolAdd(signalP, px1, gy + 5.6, pz1, ry);
      trackResnapInstance(signalP, idxSignal, px1, pz1, 5.6);
      const idxLamp = poolAdd(lampP, px1, gy + 5.6, pz1, ry, 0.9, 0.9, 0.9,
              Math.random() < 0.6 ? 0x33ff66 : 0xff4433);
      trackResnapInstance(lampP, idxLamp, px1, pz1, 5.6);
    }
    // 【2026-07-18・ユーザー判断で撤去】青看板・標識(ポール+看板)。街並みに不要な
    // 小物として撤去要望。signBoardPプール自体はpart2.jsに残しているが、poolAdd呼び出しを
    // やめたので以降生成されない(既存プレイ中の分は該当チャンクの再生成/リロードで消える)。
  }
}

// ======= STATION LANDMARKS =======
const stationLabels = []; // for billboard update each frame
// 駅を構成する全パーツ(駅舎・プラットホーム・看板等)をrecordにまとめておき、
// NEAR高解像度地形が後から届いた時にrebuildStationHeight()でY方向にまとめて
// 追従させる。以前は生成時のgy(=届いていればNEAR、届いていなければFAR基準)で
// 固定していたため、FAR基準で建った駅がNEAR到着後も浮いたまま取り残されていた
// (建物・道路と違って駅だけこの追従の仕組みが無かった)。
const stationRecords = [];

// 【2026-07-21】駅舎本体・プラットホーム(現実モード)/装飾塔(江戸・メルヘン・宇宙モード)の
// 物理生成を撤去(ユーザー要望)。以前はstationOverlapsOtherTrackで本体の被り回避を
// 試みていたが(2026-07-20)、プラットホームや複数線路が並ぶ駅では被りが解消しきれず、
// 「駅舎が線路上・道路上に残存する」報告が続いていた。駅名の看板(billboard)だけ残し、
// 地面や線路と干渉しうる立体物は一切置かないことで根本的に解消する。

function addStation(x, z, name) {
  const gy = getGroundY(x, z); // 地表基準にしないと高地の駅ランドマークが埋まる
  const parts = []; // このパーツをまとめて後からY方向に平行移動する(rebuildStationHeight)
  const refX = x, refZ = z; // rebuild時に地形高さを再サンプリングする基準点
  const labelY = gy + 20; // 駅名看板は地表から少し浮かせて視認性を確保

  // Name label (canvas texture billboard)
  const cvs = document.createElement('canvas');
  cvs.width = 512; cvs.height = 96;
  const ctx2d = cvs.getContext('2d');
  ctx2d.fillStyle = 'rgba(20,10,0,0.85)';
  ctx2d.fillRect(0, 0, 512, 96);
  ctx2d.strokeStyle = '#ffcc00';
  ctx2d.lineWidth = 4;
  ctx2d.strokeRect(2, 2, 508, 92);
  ctx2d.fillStyle = '#ffee44';
  ctx2d.font = 'bold 52px sans-serif';
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';
  ctx2d.fillText(name, 256, 48);
  const tex = new THREE.CanvasTexture(cvs);
  const labelMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 8),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthTest: false })
  );
  labelMesh.position.set(x, labelY, z);
  scene.add(labelMesh);
  parts.push(labelMesh);
  stationLabels.push({ type: 'label', mesh: labelMesh, x, z });

  // NEAR高解像度地形が後から届いた時にY方向へまとめて追従できるよう記録しておく
  // (道路・建物と同じ仕組み。以前は駅だけこれが無く、FAR基準で建った駅が浮いたまま残った)
  stationRecords.push({ refX, refZ, gy: getGroundY(refX, refZ), parts });
}

// 1駅ぶんを現在の地形に合わせてY方向へ平行移動する(rebuildBuildingHeightと同じ考え方)
function rebuildStationHeight(rec) {
  const newGy = getGroundY(rec.refX, rec.refZ);
  const delta = newGy - rec.gy;
  if (Math.abs(delta) < 0.05) return; // 誤差レベルは無視
  for (const p of rec.parts) { if (p) p.position.y += delta; }
  rec.gy = newGy;
}
// 矩形範囲(ワールド座標)にかかる駅を、現在の地形に合わせてまとめて追従させる。
// rebuildBuildingsInBoundsと同じタイミング(NEAR再取得時・チャンク生成時)で呼ぶ。
// 駅は数が少ないため建物のような空間グリッドは使わず線形走査で十分。
function rebuildStationsInBounds(x0, x1, z0, z1) {
  for (const rec of stationRecords) {
    if (rec.refX < x0 || rec.refX > x1 || rec.refZ < z0 || rec.refZ > z1) continue;
    rebuildStationHeight(rec);
  }
}

// ======= OSM DATA LOADER =======
const statusEl = document.getElementById('status');
// トースト化: sticky=true の間は自動で消えない(次の呼び出しか手動再表示まで保持)
let _toastTimer = null;
function showToast(msg, opts) {
  opts = opts || {};
  statusEl.textContent = msg;
  statusEl.style.display = 'block';
  statusEl.style.opacity = '1';
  clearTimeout(_toastTimer);
  if (!opts.sticky) {
    _toastTimer = setTimeout(() => {
      statusEl.style.opacity = '0';
      setTimeout(() => { statusEl.style.display = 'none'; }, 400);
    }, opts.duration || 3000);
  }
}
// 初期スポーン: 神奈川県伊勢原市東成瀬2-2-11
// (国土地理院ジオコーディング「東成瀬2番地」= 35.409103, 139.342331)
const SPAWN_LAT = 35.409103, SPAWN_LON = 139.342331;
// 初期OSM取得範囲と詳細地形はスポーン位置が中心になるよう定義(スパンは従来と同じ0.04°×0.03°)。
// ワールド原点(0,0)=この範囲の中心=スポーン地点となり、以降の全計算が自動で整合する
const OSM_BOUNDS = {
  minLat: SPAWN_LAT - 0.02, minLon: SPAWN_LON - 0.015,
  maxLat: SPAWN_LAT + 0.02, maxLon: SPAWN_LON + 0.015
};
const SCALE = 111000; // 1 game unit = 1 meter
// 【重要】原点(MID_LAT/MID_LON)は元々「初期スポーン=伊勢原」に固定のconstだった。
// 海外(米国など)へジャンプするとプレイヤーのワールド座標が原点から数千〜数万km相当の
// 巨大な数値になり、three.jsがGPUへ座標・行列をfloat32(有効数字約7桁)でアップロードする際に
// 精度を使い果たして地面・道路・樹木がちらつく(位置ジッター/z-fighting)不具合が起きていた。
// そこで原点を`let`にして可変にし、遠方へジャンプする時だけジャンプ先へ原点を付け替える
// (recenterOrigin、part7.jsのjumpToLatLonから呼ぶ)。ローカル座標を常に原点付近の
// 小さな値に保つ「浮動原点(floating origin)」方式。既存の建物・地形は付け替え前の
// 原点基準のまま(数値としては正しい)残るが、遠方へ飛ぶ時点でどのみち体感上は
// 二度と戻らない距離になるため実害はない(既存のチャンク破棄・再生成の仕組みと整合的)。
let MID_LAT = (OSM_BOUNDS.minLat + OSM_BOUNDS.maxLat) / 2;
let MID_LON = (OSM_BOUNDS.minLon + OSM_BOUNDS.maxLon) / 2;
let COS_LAT = Math.cos(OSM_BOUNDS.minLat * Math.PI / 180);

// 原点をlat,lonへ付け替える(浮動原点の再設定)。COS_LATも現在地の緯度に合わせて更新するため、
// 経度→メートル換算の精度も(伊勢原基準の固定値だった頃に比べ)副次的に改善する。
// 【2026-07-14】地形描写を伊勢原専用メッシュ廃止・全地域共通(part5/part6.js)に統一したのに
// 合わせ、ここでは regionBaseReady(part6.js)を false に戻すだけでよい。次の loadNearTerrain
// 成功時に、新しい地域の実データから elevBase/ROCK_Y/SNOW_Y/TREELINE/海面高さが確定し直される。
function recenterOrigin(lat, lon) {
  MID_LAT = lat; MID_LON = lon;
  COS_LAT = Math.cos(lat * Math.PI / 180);
  regionBaseReady = false;
  // 【2026-08-12・COASTLINE_CANDIDATE_SET.md】coastlineWayStore/coastlineIslandStoreは
  // 旧原点基準のx,z座標を保持しているため、原点付け替えで全部無効になる。忘れると
  // 別都市の海岸線が新しい原点の座標系に紛れ込む(この関数はcoastlineWayStore/
  // coastlineIslandStoreより前で宣言されているが、constの初期化順は影響しない——この関数の
  // 中身が実行されるのはスクリプト全体のロード完了後なので問題ない)。
  if (typeof coastlineWayStore !== 'undefined') coastlineWayStore.clear();
  if (typeof coastlineIslandStore !== 'undefined') coastlineIslandStore.clear();
  // 【2026-08-13・SEA_FROM_COASTLINE_CHAINS.md】つなげたchain/ring/segsも旧原点基準の座標
  // なので、ストアと同時に無効化する(忘れると別都市のchainが新しい原点の海面判定に混ざる)。
  if (typeof coastlineChains !== 'undefined') { coastlineChains = null; _coastlineChainsDirty = true; }
}

function latLonToXZ(lat, lon) {
  const x = (lon - MID_LON) * SCALE * COS_LAT;
  const z = -((lat - MID_LAT) * SCALE);
  return { x, z };
}

// ======= 面フィーチャ(公園・水域・田畑・森) =======
const avoidPolygons = []; // 手続き生成の建物を建ててはいけない領域
const avoidGrid = new Map(); // polyGridAdd/queryPolyGridで使う空間ハッシュ(全件走査を避ける)
// 【2026-07-16】water 80→400。水の多いエリア(東京湾岸・大河川流域)ではセッション累計80枚が
// すぐ尽き、以降の川・池の実形状ポリゴンが全てスキップされて細い推定幅リボンだけが残っていた
// (「川幅が実際より細い」の主因)。水面ポリゴンは単純な面メッシュなので400でも負荷は軽い。
// 【2026-07-17・CODE_REVIEW_20260717 P8-a】park/campusも長距離移動ですぐ尽き、
// 「後から訪れた地域だけ公園の芝生・キャンパス地面が無い」状態になっていたため、
// water同様400へ増枠(面メッシュ自体は軽いので負荷影響は小さい)。
// 【2026-08-01】distance based eviction(evictFarAreaPolys)を試したが「すぐにリボンだけに
// なった」と実機報告があり無効化(above unloadFarAreaPolys呼び出し箇所参照)。回収して
// 再利用する方式の代わりに、同じ「面メッシュは軽い」根拠でwaterをさらに増枠する安全側の対応。
// 【2026-08-04】sea 800→2000→4000。NYのように狭い水路の両岸が同じタイルに複数区間(chain)
// ぶん収まる密な海岸線に加え、Phase2(タイル中心の海側全塗り)をPhase1と無条件併用に
// 変更したことで1タイルあたりの消費数がさらに増えるため引き上げ。
const areaPolyBudget = { park: 400, water: 1600, farm: 250, campus: 400, sea: 4000 }; // 面メッシュのドローコール予算
// 予算が尽きた事実を可視化する(以前は静かに回避判定のみへフォールバックし気づけなかった)。
// 種類ごとに初回だけコンソールへ警告し、ログが埋もれないようにする。
const _areaPolyWarned = new Set();
// 【2026-07-28】予算を「セッション累計の使い切り」から「今生きている面メッシュの数」へ変える。
// タイル再取得(dropTileRemnants)で面レコードを落とした時に予算を返せるようにするため、
// どの種別で確保したかを直後に作られるentryへ引き継ぐ。areaPolyBudgetOK() は必ず
// buildAreaPoly / buildTerrainFollowingAreaPoly の直前でしか呼ばれない前提。
let _areaPolyKindPending = null;
function areaPolyTakePendingKind() { const k = _areaPolyKindPending; _areaPolyKindPending = null; return k; }
function areaPolyRefund(kind) { if (kind && areaPolyBudget[kind] != null) areaPolyBudget[kind]++; }
function areaPolyBudgetOK(kind) {
  if (areaPolyBudget[kind] > 0) { areaPolyBudget[kind]--; _areaPolyKindPending = kind; return true; }
  if (!_areaPolyWarned.has(kind)) {
    _areaPolyWarned.add(kind);
    console.warn(`[areaPolyBudget] "${kind}"の面メッシュ予算を使い切りました。以降は回避判定・ミニマップ表示のみ機能します。`);
  }
  return false;
}
// 【2026-08-03・修正B(水域限定の再試行キュー)】予算切れ(areaPolyBudgetOK('water')===false)
// で捨てた水域ポリゴンは、以前は二度と再試行されず永久に失われていた——OSMの実データが
// 確定して届いているのに、リソース制約(面メッシュのドローコール予算)だけを理由に消える。
// 「マップデータに忠実に」の大原則([[project_isehara_game_map_fidelity_first_principle]])に
// 反するため、捨てる代わりに構築済みの記述子(既に間引き済みのpts/holesと外接矩形)を
// キューへ退避し、低頻度スキャンで予算に空きができ次第(dropAreaRecordsInTileの
// areaPolyRefund等)実際にメッシュを張る。相模川のような大河川で「予算切れの警告が出ている」
// とユーザー報告・確認済み(2026-08-03)。
const pendingAreaWaterPolys = []; // { pts, holes, minX, maxX, minZ, maxZ }
function _commitWaterPoly(pts, holes, minX, maxX, minZ, maxZ) {
  // 【2026-08-12・RIVER_DRAPES_ON_TERRAIN.md】水面は地形の真上に貼り付くので、遠距離では
  // 深度バッファ精度で地形と混ざる。旧yOff=0.15では足りないため0.5へ引き上げた
  // (地形との競合はこの高さでなくwaterAreaMatの深度バイアス側でも二重に解決する)。
  buildAreaPoly(pts, waterAreaMat, 0.5, holes);
  const entry = { pts, minX, maxX, minZ, maxZ };
  minimapWaterPolys.push(entry);
  polyGridAdd(minimapWaterGrid, entry);
  // 【2026-08-03・「橋が架かっているところと水に埋もれているところがある」の真因対策】
  // 道路(橋)タイルと水面タイル/relationはOverpassから独立に、到着した順に処理される
  // (処理順の保証は無い)。橋が先に処理されると、その時点ではwaterSurfaceYAtがまだ
  // 何も見つけられないため`bridgeSegmentY`はクリアランス無しの高さで確定してしまい、
  // 後からこの水面ポリゴンが届いても誰も橋を作り直さないため、水没したまま固定されていた
  // (=「架かっている/埋もれている」の違いは、単にどちらが先にtileで届いたか次第だった)。
  // 水面が確定した瞬間に、その範囲(バンクのアンカーがbboxよりわずかに外側にあるケースを
  // 吸収するmargin付き)にかかる道路(橋を含む)を強制的に作り直させる。
  const margin = 60;
  if (typeof rebuildRoadsInBounds === 'function') {
    rebuildRoadsInBounds(minX - margin, maxX + margin, minZ - margin, maxZ + margin);
  }
}
function queueWaterPolyRetry(pts, holes, minX, maxX, minZ, maxZ) {
  pendingAreaWaterPolys.push({ pts, holes, minX, maxX, minZ, maxZ });
}
let _waterRetryScanFrame = 0;
function scanPendingAreaWaterPolys() {
  _waterRetryScanFrame++;
  if (_waterRetryScanFrame % 90 !== 0) return; // 他の低頻度スキャナ(scanGateWaitQueues等)と同じ周期
  if (pendingAreaWaterPolys.length === 0) return;
  const keep = [];
  for (const e of pendingAreaWaterPolys) {
    if (areaPolyBudgetOK('water')) {
      _commitWaterPoly(e.pts, e.holes, e.minX, e.maxX, e.minZ, e.maxZ);
    } else {
      keep.push(e); // 予算がまだ無ければ次回スキャンへ持ち越す
    }
  }
  pendingAreaWaterPolys.length = 0;
  for (const e of keep) pendingAreaWaterPolys.push(e);
}
const lawnMat  = new THREE.MeshLambertMaterial({ color: MODE_CONF.lawn, side: THREE.DoubleSide });
// リボン(ROAD_MAT.water)と同じMeshBasicにして、重なっても境目が見えないようにする
// 【2026-08-12・RIVER_DRAPES_ON_TERRAIN.md 6】水面は地形の真上に貼り付くので地形とほぼ同一
// 平面になる。これを高さ(安全余裕の積み増し)で解決しようとしたのが「10回以上の浮く/沈む
// 往復」の構造的な原因だったため、描画側(深度バイアス)で解決する。polygonOffsetFactor/Units
// を負にすると、深度上だけ手前(カメラ側)へ押し出され、地形と同一平面でも常に水面が勝つ
// (見た目の頂点位置は変えない)。水面が常に地形の真上(=地形と同じ高さ帯)になったことで
// 遠距離では深度バッファの精度不足がさらに強く効くため、旧-2/-4から強めた。
const waterAreaMat = new THREE.MeshBasicMaterial({
  color: MODE_CONF.water, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
});
const minimapWaterPolys = []; // ミニマップに描く実形状水面 {pts,minX,maxX,minZ,maxZ}
const minimapWaterGrid = new Map(); // polyGridAdd/queryPolyGridで使う空間ハッシュ(全件走査を避ける)
// 田畑: あぜ縞のcanvasテクスチャ(uv=世界座標なので repeat で約9m周期の縞になる)
const farmMat = (() => {
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  const g = c.getContext('2d');
  const fc = MODE === 'space' ? ['#2a3240', '#3a4756'] // 無機質グリッド
           : MODE === 'marchen' ? ['#7bd06a', '#e8c87a']
           : ['#6a8a3a', '#8a7a4a'];
  g.fillStyle = fc[0]; g.fillRect(0, 0, 32, 32);
  g.fillStyle = fc[1]; g.fillRect(0, 12, 32, 8);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / 9, 1 / 9);
  return new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
})();

// 校庭(学校の敷地全体): 土の粒状テクスチャ+陸上トラックの白線を1枚のcanvasに焼き込む。
// buildAreaPoly(ShapeGeometry)は敷地の外接矩形基準で自動的にUV0..1を割り振るため、
// このテクスチャはrepeatさせず、敷地の外接矩形にちょうど1つ収まるように描けばよい。
const campusGroundMat = (() => {
  const c = document.createElement('canvas'); c.width = 512; c.height = 384;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.fillStyle = '#b89868'; // 土
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 3500; i++) { // 粒状ノイズ
    const rgb = [100 + Math.random()*50|0, 80 + Math.random()*40|0, 50 + Math.random()*30|0];
    g.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.35)`;
    g.fillRect(Math.random()*W, Math.random()*H, 2, 2);
  }
  // 陸上トラック(白線、スタジアム形=直線+半円のレーンを6本)
  const cx = W/2, cy = H/2;
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  for (let lane = 0; lane < 6; lane++) {
    const rx = W*0.42 - lane*15, ry = H*0.36 - lane*11;
    if (rx < 30 || ry < 18) break;
    const straight = Math.max(0.1, rx - ry);
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx - straight, cy - ry);
    g.lineTo(cx + straight, cy - ry);
    g.arc(cx + straight, cy, ry, -Math.PI/2, Math.PI/2, false);
    g.lineTo(cx - straight, cy + ry);
    g.arc(cx - straight, cy, ry, Math.PI/2, -Math.PI/2, false);
    g.closePath();
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  return new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
})();

// 【2026-07-18】スポーツ施設(野球場・サッカー場・陸上競技場)の再現度向上。
// campusGroundMat(校庭の陸上トラック描画)と同じ「canvasテクスチャを1枚焼いて
// buildTerrainFollowingAreaPolyの外接矩形UVに載せる」手法を使う。leisure=pitch
// (sportタグでサッカー/野球を判定)とleisure=trackを対象に、種目ごとの見た目を割り当てる。
const pitchSoccerMat = (() => {
  const c = document.createElement('canvas'); c.width = 256; c.height = 384;
  const g = c.getContext('2d'); const W = c.width, H = c.height;
  g.fillStyle = '#2f8f47'; g.fillRect(0, 0, W, H); // 芝(公園の芝より濃い緑にして区別)
  g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 3;
  const m = 14; // 外周ライン
  g.strokeRect(m, m, W - m * 2, H - m * 2);
  g.beginPath(); g.moveTo(m, H / 2); g.lineTo(W - m, H / 2); g.stroke(); // ハーフウェイライン
  g.beginPath(); g.arc(W / 2, H / 2, Math.min(W, H) * 0.13, 0, Math.PI * 2); g.stroke(); // センターサークル
  // ゴールエリア(上下)
  g.strokeRect(W / 2 - W * 0.22, m, W * 0.44, H * 0.09);
  g.strokeRect(W / 2 - W * 0.22, H - m - H * 0.09, W * 0.44, H * 0.09);
  return new THREE.MeshLambertMaterial({ map: new THREE.CanvasTexture(c), side: THREE.DoubleSide });
})();
const pitchBaseballMat = (() => {
  const c = document.createElement('canvas'); c.width = 384; c.height = 384;
  const g = c.getContext('2d'); const W = c.width, H = c.height;
  g.fillStyle = '#3a9d4f'; g.fillRect(0, 0, W, H); // 外野芝
  // 内野(土色の扇形)。ホームベースを左下角付近に置き、ライト方向へ扇形に広げる簡略化表現。
  const hx = W * 0.18, hy = H * 0.82, R = Math.min(W, H) * 0.62;
  g.fillStyle = '#c8a26a';
  g.beginPath(); g.moveTo(hx, hy); g.arc(hx, hy, R, -Math.PI / 2 - 0.05, 0 + 0.05, false); g.closePath(); g.fill();
  // ベースライン(白線、ダイヤモンド)
  const d = R * 0.42;
  g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 3;
  g.beginPath();
  g.moveTo(hx, hy); g.lineTo(hx + d, hy - d); g.lineTo(hx + d * 2, hy); g.lineTo(hx + d, hy + d); g.closePath();
  g.stroke();
  return new THREE.MeshLambertMaterial({ map: new THREE.CanvasTexture(c), side: THREE.DoubleSide });
})();
// 多目的・その他スポーツ(テニス・バスケ等): 公園の芝と紛れないよう少し彩度を上げた緑の無地
const pitchGenericMat = new THREE.MeshLambertMaterial({ color: 0x389a53, side: THREE.DoubleSide });
// 陸上競技場(leisure=track、学校敷地とは別に単独施設として存在するもの)。
// campusGroundMatの白線トラック(土台)と違い、トラック面自体を赤茶色の帯で表現する。
const trackMat = (() => {
  const c = document.createElement('canvas'); c.width = 512; c.height = 384;
  const g = c.getContext('2d'); const W = c.width, H = c.height;
  g.fillStyle = '#3a9d4f'; g.fillRect(0, 0, W, H); // フィールド(芝)
  const cx = W / 2, cy = H / 2, rx = W * 0.42, ry = H * 0.36, straight = Math.max(0.1, rx - ry);
  const stadiumPath = (rr) => {
    g.beginPath();
    g.moveTo(cx - straight, cy - rr);
    g.lineTo(cx + straight, cy - rr);
    g.arc(cx + straight, cy, rr, -Math.PI / 2, Math.PI / 2, false);
    g.lineTo(cx - straight, cy + rr);
    g.arc(cx - straight, cy, rr, Math.PI / 2, -Math.PI / 2, false);
    g.closePath();
  };
  g.fillStyle = '#b5502a'; // トラック面(赤茶)。外周から内周をくり抜いて帯状にする
  stadiumPath(ry); g.fill('evenodd');
  stadiumPath(ry * 0.72); g.globalCompositeOperation = 'destination-out'; g.fill(); g.globalCompositeOperation = 'source-over';
  g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1.5;
  for (let lane = 1; lane < 7; lane++) { stadiumPath(ry - lane * (ry * 0.28 / 7)); g.stroke(); }
  return new THREE.MeshLambertMaterial({ map: new THREE.CanvasTexture(c), side: THREE.DoubleSide });
})();
function pitchMatFor(sport) {
  if (sport === 'soccer' || sport === 'football') return pitchSoccerMat;
  if (sport === 'baseball' || sport === 'softball') return pitchBaseballMat;
  return pitchGenericMat;
}

// ポリゴンから地形に沿った面メッシュを1枚生成(三角形分割はShapeGeometry=earcut)
// holes: 内周リング(中州など)の配列(省略可)
// 水域・公園・田畑ポリゴンのメッシュ一覧。NEAR高解像度地形が更新されたとき、
// 範囲にかかるものだけ高さを再スナップする(浮き/埋まり対策。道路と同じ考え方)。
const areaPolyMeshes = [];
const areaPolyGrid = new Map(); // polyGridAdd/queryPolyGridで使う空間ハッシュ(全件走査を避ける)
// 【2026-08-12・IMPL_PROMPT_20260812_RIVER_DRAPES_ON_TERRAIN.md】水位の推定機構
// (_collectWaterNodes/_binLowPercentile/_computeWaterProfileFromNodes/_computeWaterProfile/
// _waterProfileChanged/_isNearCoverage、および定数WATER_BIN/WATER_FLAT_MAX_SPAN/
// WATER_MAX_SAMPLES)を全廃した。DEMは陸の製品で水域上の値は測定されていないため、そこから
// 水位を推定する限り推定を間違えれば水面は上へ逃げるか下へ沈む(実機実測で両方発生・
// 確定済み)。水面はその場所の地形の真上に置く(_waterYAt参照)ことで、この2つの災害モード
// は定義上起きなくなる。死んだコードを残すと次の誤読を生むため、全部消す
// (削除した識別子への参照が無いことはgrepで確認済み)。
// 細い川では地形ノード(200m間隔)が1本もポリゴン内側に入らないビンがありうるため、
// 輪郭からmargin以内の外側ノードも候補に含める(pointInPolygonがfalseの場合の救済)。
// 【waterSurfaceYAtの境界マージン判定で使用、現役】
function _nearPolygonBoundary(px, pz, pts, margin) {
  const m2 = margin * margin;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if (distSqPointToSeg(px, pz, pts[i].x, pts[i].z, pts[j].x, pts[j].z) <= m2) return true;
  }
  return false;
}
// 【2026-08-03・橋が水面に埋もれる不具合対策】(x,z)地点にかかっている水面ポリゴンの
// 現在の水位を返す(無ければnull)。part3.js側の橋の高さ計算(bridgeSegmentY)が、
// 川筋の水位を無視してバンク2点のgetGroundYだけを直線補間していたため、水面側の
// かさ上げ(_computeWaterProfileのmax+マージン+単調伝播+上向きスムージング)が
// 橋の直線より高くなり、橋桁が水没して見える不具合が発生した。この関数で橋側から
// 「実際にここの水位はいくつか」を問い合わせられるようにする。
// 【2026-08-03・v3(ログ無しでの推測修正)】v2までの一連の修正後も「潜って見ると水面の下に
// 橋路面がある」と再報告された。厳密な`pointInPolygon`だけでは、橋のOSM way(道路として
// 別途デジタイズされている)の経路と、水面ポリゴンの輪郭(河岸として別途デジタイズされて
// いる)の間にメートル単位のズレがあるケースを取りこぼす可能性がある(道と水域は別の
// 実測起源のデータで、境界が数m〜十数mずれて噛み合わないことは珍しくない)。橋の
// クリアランス判定という用途では「水を見逃す(=水没)」方が「陸地なのに少し余分に
// 底上げする」より実害が大きいため、輪郭から`WATER_QUERY_MARGIN`だけ外側も「水がある」
// とみなす。
const WATER_QUERY_MARGIN = 20; // 水域ポリゴン輪郭からのマージン(m)。橋の見逃しより誤検出の方が実害が小さいため寄せる
function waterSurfaceYAt(x, z) {
  let best = null;
  const m = WATER_QUERY_MARGIN;
  for (const e of queryPolyGrid(areaPolyGrid, x - m, x + m, z - m, z + m)) {
    // 【2026-08-12・RIVER_DRAPES_ON_TERRAIN.md】waterProfileはもう存在しない(削除済み)。
    // ここを直し忘れると橋が全部水面を見失う。
    if (e.kind !== 'flat') continue;
    if (x < e.minX - m || x > e.maxX + m || z < e.minZ - m || z > e.maxZ + m) continue;
    if (!pointInPolygon(x, z, e.pts) && !_nearPolygonBoundary(x, z, e.pts, m)) continue;
    let inHole = false;
    // 中州(hole)の「内側の奥」までマージンで拾ってしまわないよう、hole側は厳密判定のまま
    if (e.holes) { for (const hp of e.holes) { if (hp.length >= 4 && pointInPolygon(x, z, hp)) { inHole = true; break; } } }
    if (inHole) continue;
    const y = _waterYAt(e, x, z);
    if (best === null || y > best) best = y;
  }
  return best;
}
// 【2026-08-12・IMPL_PROMPT_20260812_RIVER_DRAPES_ON_TERRAIN.md】水位の推定をやめた。
// DEMは陸の製品で水域上の値は測定されていないため、そこから水位を導く限り上に逃げるか
// 下に沈む(実機実測でp10導入前後どちらも発生・確定済み)。海だけ平均海面で水平に固定し、
// それ以外(川・池)は地形の真上に置く。getGroundY(=farSurfaceY)は「描画される地形メッシュ
// 表面と厳密に一致する高さ」という本プロジェクト唯一の健全な不変条件なので、水面は地形の
// 平行オフセット面になり、「水面が上空に浮く」「地形の下に隠れる」のどちらも定義上起きない。
function _waterYAt(entry, x, z) {
  if (entry.fixedY != null) return entry.fixedY + entry.yOff; // 海
  return getGroundY(x, z) + entry.yOff;                        // 川・池
}
// 【2026-08-03】辺(弦)が地形を切って「地面が混ざり込む」のを防ぐため、最長辺がMAX_EDGE以下に
// なるまで三角形を1→4の中点分割で再帰的に細分する。中点は辺キー("小さい方の頂点index_大きい方")
// でキャッシュし、隣接三角形と必ず同じ中点頂点を共有する(共有しないとT-junction=筋状の隙間ができる)。
function subdivideTriangles(verts2D, idx, maxEdge) {
  const maxEdge2 = maxEdge * maxEdge;
  const midCache = new Map();
  const vx = i => verts2D[i * 2], vz = i => verts2D[i * 2 + 1];
  const edgeLen2 = (a, b) => { const dx = vx(a) - vx(b), dz = vz(a) - vz(b); return dx * dx + dz * dz; };
  function midpoint(a, b) {
    const key = a < b ? a + '_' + b : b + '_' + a;
    let m = midCache.get(key);
    if (m != null) return m;
    m = verts2D.length / 2;
    verts2D.push((vx(a) + vx(b)) / 2, (vz(a) + vz(b)) / 2);
    midCache.set(key, m);
    return m;
  }
  let tris = [];
  for (let i = 0; i < idx.length; i += 3) tris.push([idx[i], idx[i + 1], idx[i + 2]]);
  let guard = 0, changed = true;
  while (changed && guard++ < 12) { // 1周ごとに最長辺は概ね半減するので12周もあれば十分すぎる安全弁
    changed = false;
    const next = [];
    for (const [a, b, c] of tris) {
      if (Math.max(edgeLen2(a, b), edgeLen2(b, c), edgeLen2(c, a)) <= maxEdge2) { next.push([a, b, c]); continue; }
      changed = true;
      const mAB = midpoint(a, b), mBC = midpoint(b, c), mCA = midpoint(c, a);
      next.push([a, mAB, mCA], [mAB, b, mBC], [mCA, mBC, c], [mAB, mBC, mCA]);
    }
    tris = next;
  }
  const outIdx = [];
  for (const [a, b, c] of tris) outIdx.push(a, b, c);
  return outIdx;
}
function rebuildAreaPolyMesh(entry) {
  if (!entry.mesh) return; // 遠方でGPU解放済み(unloadFarAreaPolys参照)。再接近時に自然と再構築される
  const pos = entry.mesh.geometry.attributes.position;
  if (entry.kind === 'flat') {
    // 【2026-08-12・RIVER_DRAPES_ON_TERRAIN.md】水位はもう推定しない(=地形の真上に置くだけ)
    // ので、NEAR地形の到達ごとにプロファイルを再計算する経路自体が丸ごと不要になった。
    // 地形が後から届いたときの追従は、loadNearTerrain/loadWideTerrainがrebuildAreaPolysInBounds
    // を呼ぶ既存経路でそのまま効く(下のpos.setY自体がgetGroundY経由でその時点の最新の
    // 地形高さを読むため)。海は高さが変わらないので何もしない。
    if (entry.fixedY != null) return;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setY(i, _waterYAt(entry, x, z)); // yOffは_waterYAt内で加算済み
    }
  } else {
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i); // Y(高さ)だけ書き換えるのでX/Zはそのまま読める
      pos.setY(i, getGroundY(x, z) + entry.yOff);
    }
  }
  pos.needsUpdate = true;
  entry.mesh.geometry.computeVertexNormals();
  entry.mesh.geometry.computeBoundingSphere();
}
// 【重要】以前はareaPolyMeshes(取得済み全件。増え続けて減らない)を毎回全件走査していた。
// NEAR地形の再取得・チャンク生成のたびに呼ばれる頻出パスなので、探索が進むほど
// コストが際限なく悪化していた(長時間プレイでの重量化の主因の一つ)。空間ハッシュで近傍だけ拾う。
function rebuildAreaPolysInBounds(x0, x1, z0, z1) {
  for (const e of queryPolyGrid(areaPolyGrid, x0, x1, z0, z1)) {
    // グリッドはセル単位(粗い)なので、無駄な再構築を避けるため最後に正確なbboxで絞る
    if (e.maxX < x0 || e.minX > x1 || e.maxZ < z0 || e.minZ > z1) continue;
    rebuildAreaPolyMesh(e);
  }
}

// entry.kindごとのジオメトリ構築だけを担う純粋な部分。entry.mesh===null(初回 or 遠方解放後)を
// entry.mesh=new THREE.Mesh(...)で埋める。scene.addまで行う(呼び出し元では触らない)。
// 【2026-07-17】unloadFarAreaPolysの再構築でも使う共有ロジックとして、buildAreaPoly/
// buildTerrainFollowingAreaPolyの本体からentry生成後に呼ぶ形に切り出した。
function _instantiateAreaPolyMesh(entry) {
  let geo;
  if (entry.kind === 'flat') {
    // 【2026-08-03 Fable5相談・4回目修正】格子分割(3回目修正)は輪郭を軸並行の四角形で
    // 近似してしまい「川の形が四角」という新たな不具合を生んだため撤回。ShapeGeometry
    // (OSM輪郭pts/holesをそのまま使う=ネイティブhole対応込み)に戻し、代わりに
    // 「辺(弦)が地形を切る」問題をsubdivideTriangles(このファイル上部)による再分割で
    // 解決する。【2026-08-12・RIVER_DRAPES_ON_TERRAIN.md】水面は今や地形の真上(_waterYAt=
    // getGroundY+yOff)を辿るため、最長辺100mのままだと弦が地形の三角形をまたいで沈む
    // ケースが増える。50mへ細分化を強めた。
    const { pts, holes, yOff } = entry;
    const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.z)));
    if (holes) {
      for (const hp of holes) {
        if (hp.length >= 4) shape.holes.push(new THREE.Path(hp.map(p => new THREE.Vector2(p.x, p.z))));
      }
    }
    const shapeGeo = new THREE.ShapeGeometry(shape);
    const srcPos = shapeGeo.attributes.position;
    const srcUv = shapeGeo.attributes.uv;
    const verts2D = []; // [x0,z0, x1,z1, ...] (Y抜きの平面座標。高さは後でsubdivide後の頂点にまとめて計算する)
    const uvs2D = [];
    for (let i = 0; i < srcPos.count; i++) { verts2D.push(srcPos.getX(i), srcPos.getY(i)); uvs2D.push(srcUv.getX(i), srcUv.getY(i)); }
    let idx = shapeGeo.index ? Array.from(shapeGeo.index.array) : null;
    if (!idx || idx.length === 0) return false; // 退化ポリゴン(自己交差/点不足等)は諦める
    idx = subdivideTriangles(verts2D, idx, 50);
    // subdivideTrianglesがverts2Dに中点を追加している可能性があるのでuvsも同じ規則で追い付かせる
    for (let i = uvs2D.length / 2; i < verts2D.length / 2; i++) { uvs2D.push(verts2D[i * 2], verts2D[i * 2 + 1]); }
    const nVerts = verts2D.length / 2;
    const verts = new Float32Array(nVerts * 3);
    for (let i = 0; i < nVerts; i++) {
      const x = verts2D[i * 2], z = verts2D[i * 2 + 1];
      verts[i * 3] = x;
      verts[i * 3 + 1] = _waterYAt(entry, x, z);
      verts[i * 3 + 2] = z;
    }
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs2D, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
  } else { // 'terrain'(buildTerrainFollowingAreaPoly)
    const { minX, maxX, minZ, maxZ, pts, yOff, cellSize, worldUV } = entry;
    const nx = Math.max(1, Math.min(80, Math.ceil((maxX - minX) / cellSize)));
    const nz = Math.max(1, Math.min(80, Math.ceil((maxZ - minZ) / cellSize)));
    const verts = [], uvs = [], idx = [];
    const grid = [];
    for (let j = 0; j <= nz; j++) {
      const row = [];
      for (let i = 0; i <= nx; i++) {
        const x = minX + (maxX - minX) * i / nx;
        const z = minZ + (maxZ - minZ) * j / nz;
        if (!pointInPolygon(x, z, pts)) { row.push(-1); continue; }
        row.push(verts.length / 3);
        verts.push(x, getGroundY(x, z) + yOff, z);
        uvs.push(worldUV ? x : i / nx, worldUV ? z : j / nz);
      }
      grid.push(row);
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], d = grid[j + 1][i];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue; // 境界セル(ポリゴン外の頂点を含む)は張らない
      idx.push(a, b, c, a, c, d);
    }
    if (idx.length === 0) return false; // 細すぎる/境界だけのポリゴンはフォールバックなしで諦める
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
  }
  const mesh = new THREE.Mesh(geo, entry.mat);
  mesh.renderOrder = 1;
  scene.add(mesh);
  entry.mesh = mesh;
  return true;
}

function buildAreaPoly(pts, mat, yOff, holes) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  // kind/pts/holes/matを保持しておくのは、遠方でGPU解放した後に再接近時、記録から
  // 再構築できるようにするため(道路のrebuildRoadMesh/unloadFarRoadsと同じ考え方。
  // CODE_REVIEW_20260717 P8: 以前はここで一度作ったら二度と解放されなかった)。
  const entry = { mesh: null, kind: 'flat', areaKind: areaPolyTakePendingKind(), pts, holes, mat, yOff, minX, maxX, minZ, maxZ };
  // 【2026-08-12・RIVER_DRAPES_ON_TERRAIN.md】高さのキャッシュ(entry.waterProfile)は不要に
  // なった。_waterYAtは毎回getGroundY(x,z)を直接読むだけなので、_instantiateAreaPolyMesh/
  // rebuildAreaPolyMeshの両方が_waterYAt経由でこれを参照するだけ、という二重実装防止の
  // 構造はそのまま活きている(参照先が「キャッシュ」から「地形メッシュそのもの」に変わっただけ)。
  if (!_instantiateAreaPolyMesh(entry)) { areaPolyRefund(entry.areaKind); return; }
  areaPolyMeshes.push(entry);
  polyGridAdd(areaPolyGrid, entry);
}

// ======= 【2026-08-04】外洋(海)の水面 =======
// OSMは外洋を natural=water では表現しない。natural=coastline という「線」データで陸/海の
// 境界を表すだけで、面としての海はレンダラー側が組み立てる責任になる(osmcoastline等の
// 専用ツールが担う処理)。今までnatural=coastlineを一切取得しておらず、川ポリゴン(natural=water/
// waterway=riverbank)が終わる河口から先には面データが何も存在しなかったため、水路センター
// ラインのリボンだけが残っていた(「河口付近がリボンだけになる」不具合の真因、ユーザー確認済み)。
//
// 簡易版として、coastlineの線が実際に通過するOSMタイル(OSM_TILE_M四方)だけ、タイル矩形を
// coastlineの海側半平面で逐次クリップ(Sutherland-Hodgman)して塗る。海から離れた開けた外洋
// (coastlineが通らないタイル)までは埋めない — 描画/生成距離内ではほぼ海岸沿いのタイルしか
// 見えないため、実用上はこれで十分という判断(processCoastlineFill呼び出し元コメント参照)。
//
// 高さは複雑な地形サンプリング(GSI標高)を一切使わず、固定の海抜0m相当(elevBase由来、
// bridgeSegmentYのtrueSeaYと同じ式)にする——ユーザー方針(2026-08-04、川の水面のような
// 地形追従サンプリングは河口付近のGSI欠測で不安定になることが今回の一連の不具合の元凶
// だったため、海は最初から「地図に忠実な固定値」にする)。
function seaLevelY() {
  return -elevBase * ELEV_SCALE;
}
// 【2026-08-04・実機報告「水面が地面の下に入ってしまっている」で発覚】地形側(part6.js
// loadWideTerrain/loadNearTerrain)は、標高データがnullでない限り
// Math.max(m, landFloorM)で必ずLAND_FLOOR_MARGIN_M(海抜+0.5m)以上に底上げする。これは
// 江東区等の0m地帯が沈んで見える対策だが、「標高データが無い(null)場所だけが海」という
// 前提に基づいており、実際にはSRTM等は広い河川・港湾の水面にもnullではない実標高値
// (0m前後)を返すことが多い。その場合、地形がlandFloorM分まで底上げされ、海面ポリゴンの
// 固定Y(seaLevelY()+0.15)より上に来てしまい、地形の下に海面が隠れて見えなくなる
// (ニューヨーク/ジャージーシティで再現・ユーザーが直接指摘)。地形側が底上げされる
// 最大量(LAND_FLOOR_MARGIN_M*ELEV_SCALE)を必ず上回る高さに海面を置くことで、
// 地形がどちらの高さになっても海面が隠れないようにする。
function seaYOffset() {
  return LAND_FLOOR_MARGIN_M * ELEV_SCALE + 0.3;
}
// buildAreaPolyと同じ'flat'種別のentryを作るが、高さはgetGroundYを辿らずentry.fixedYに
// 固定する(_waterYAt参照)。海は地形の後着で変わる理由が無く、常に平均海面と同じ高さで
// 水平であるべき、という川・池(地形に沿う)との唯一の違いがここに現れる。
function buildFixedFlatAreaPoly(pts, mat, yOff, fixedY, holes) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  const entry = { mesh: null, kind: 'flat', areaKind: areaPolyTakePendingKind(), pts, holes, mat, yOff, minX, maxX, minZ, maxZ };
  entry.fixedY = fixedY; // 【2026-08-12・RIVER_DRAPES_ON_TERRAIN.md】海だけは平均海面で水平に固定する
  if (!_instantiateAreaPolyMesh(entry)) { areaPolyRefund(entry.areaKind); return false; }
  areaPolyMeshes.push(entry);
  polyGridAdd(areaPolyGrid, entry);
  // ミニマップにも川・池と同じ扱いで載せる(海だけミニマップに出ないと不自然なため)。
  const mmEntry = { pts, minX, maxX, minZ, maxZ };
  minimapWaterPolys.push(mmEntry);
  polyGridAdd(minimapWaterGrid, mmEntry);
  // 川・池と同様、海の中には手続き生成の建物を建てさせない(handleAreaFeatureの水面と同じ扱い)。
  const avoidPoly = { pts, minX, maxX, minZ, maxZ };
  avoidPolygons.push(avoidPoly);
  polyGridAdd(avoidGrid, avoidPoly);
  return true;
}
// タイルに一度でも海面を試みたら(coastlineが無く何もしなかった場合も含め)二度と再試行しない
// —— coastlineの位置は実データなので、同じタイルへ何度到着しても結果は変わらない。
const seenCoastlineTiles = new Set();
// 【2026-08-12・IMPL_PROMPT_20260812_COASTLINE_CANDIDATE_SET.md】coastlineのwayをセッション
// 全体で保持するストア。Overpassのway(bbox)クエリはbboxと交差するwayしか返さないため、
// 川・湾の内側に完全に収まるタイル(渚が無い)の応答にはcoastlineが1本も含まれないことがある。
// 届いたwayをここへ貯め、どのタイルの判定からも参照できるようにする。
// 【注意】recenterOrigin(座標系の原点付け替え)でこのストアの座標は全部無効になるため、
// recenterOrigin側でclear()すること(忘れると別都市の海岸線が混ざる)。
const coastlineWayStore = new Map();   // el.id -> {pts,minX,maxX,minZ,maxZ}
const coastlineIslandStore = new Map(); // el.id -> 同上(閉じたリング=島)
// 【2026-08-13・IMPL_PROMPT_20260813_SEA_FROM_COASTLINE_CHAINS.md】海面の作り方を全面置換。
// 旧方式(Phase1: way単位の海側リボンをタイル矩形でSutherland-Hodgmanクリップ、Phase2: 5点
// 多数決でタイル全塗り)は、実測(NY)でサンプル6697点中35.6%が「地形が海面より+3m以上高い」
// =本物の陸だった。原因は2つ: (1) ribbonは「chainの両端点だけ」で海側を決めるため、四方を
// 海岸線に囲まれた島では島の内側を覆ってしまう(自己交差しないことと正しい側を覆うことは
// 別問題だった)。(2) Phase2の5点多数決はタイル中心付近の桟橋・入江等で誤判定し、陸の31%を
// 巻き込んでいた。今までは固定海面Y(7.30)が偶然の陸フィルタとして働き、マンハッタン
// (地形+90)の下に海面が埋もれていたため見えていなかったが、地形を水面下へ下げる修正
// ([[project_isehara_game_water_design_rewrite]]のTERRAIN_YIELDS_TO_WATER.md)で
// 「陸の水面化」として噴出した。
//
// 新方式: coastline wayを端点でつなげてchain化し(way73本→chain8本、閉じた2本が実面積と
// 一致するガバナーズ島・リバティ島とDEBUG_PROBE_20260813_COASTLINE_RINGS_V2/V3.jsで検証済み)、
// タイルをセル単位(COAST_CELL_M)に分割、各セル中心が最寄りのcoastline区間の海側かどうかで
// 「海か・海でないか」を判定する。接線の平滑化・重み付き多数決・レイ交差の巻き数はいずれも
// 実測で効果ゼロ〜不可と確定済みなので入れない([[IMPL_PROMPT_20260813_SEA_FROM_COASTLINE_CHAINS]]
// 参照)。返すのは「陸か水か」ではなく「海か、海ではないか」——「海ではない」側には陸と
// 河口・入江の水の両方が入るが、その水はnatural=waterの川ポリゴン([[RIVER_DRAPES_ON_TERRAIN]]
// で地形にドレープする実装、相模川で実機合格済み)が別途担当するので、ここで拾おうとしない。
let coastlineChains = null;      // [ [{x,z},...], ... ] way73本→chain8本(実測NY)
let coastlineRings = null;       // 閉じたchain(島)だけ
let coastlineSegs = null;        // {ax,az,bx,bz,minX,maxX,minZ,maxZ} のフラット配列
let _coastlineChainsDirty = true;
let coastlineVersion = 0; // 【2026-08-13・SEA_CLAMP_IN_FARNODEY.md】海岸線が更新されるたびに++。part5.js farNodeYの海面クランプキャッシュ世代
const COAST_JOIN_EPS = 1.0;      // 端点が一致とみなす距離(m)
function rebuildCoastlineChains() {
  const ways = [];
  for (const w of coastlineWayStore.values()) if (w && w.pts && w.pts.length >= 2) ways.push(w.pts);
  for (const w of coastlineIslandStore.values()) if (w && w.pts && w.pts.length >= 2) ways.push(w.pts);
  const key = p => Math.round(p.x / COAST_JOIN_EPS) + '|' + Math.round(p.z / COAST_JOIN_EPS);
  const ends = new Map();
  ways.forEach((pts, i) => { for (const p of [pts[0], pts[pts.length - 1]]) {
    const k = key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); } });
  const used = new Array(ways.length).fill(false);
  const takeNext = p => { for (const i of (ends.get(key(p)) || [])) if (!used[i]) return i; return -1; };
  const chains = [];
  for (let s = 0; s < ways.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    let c = ways[s].slice();
    for (;;) { const i = takeNext(c[c.length - 1]); if (i < 0) break; used[i] = true;
      const w = ways[i];
      c = c.concat(key(w[0]) === key(c[c.length - 1]) ? w.slice(1) : w.slice(0, -1).reverse()); }
    for (;;) { const i = takeNext(c[0]); if (i < 0) break; used[i] = true;
      const w = ways[i];
      c = (key(w[w.length - 1]) === key(c[0]) ? w.slice(0, -1) : w.slice(1).reverse()).concat(c); }
    chains.push(c);
  }
  coastlineChains = chains;
  coastlineRings = chains.filter(c =>
    Math.hypot(c[0].x - c[c.length - 1].x, c[0].z - c[c.length - 1].z) <= COAST_JOIN_EPS * 2);
  coastlineSegs = [];
  for (const c of chains) for (let i = 0; i < c.length - 1; i++) {
    const a = c[i], b = c[i + 1];
    coastlineSegs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z,
      minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
      minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) });
  }
  _coastlineChainsDirty = false;
  console.log('[coastline] chains=' + chains.length + ' rings=' + coastlineRings.length +
    ' segs=' + coastlineSegs.length);
  // 【2026-08-13・IMPL_PROMPT_20260813_SEA_CLAMP_IN_FARNODEY.md】chainが更新された
  // (=coastlineSegs/coastlineRingsの中身が変わった)ので、part5.js farNodeYの海面クランプ
  // キャッシュ(_seaNodeCache)を世代番号で無効化し、地形メッシュも低頻度で作り直す。
  coastlineVersion++;   // part5.js の海判定キャッシュを無効化する
  _seaMeshDirty = true;
}
// 1点(px,pz)が「海か」を判定する。海側ベクトル=進行方向の右手側=(-dz,dx)(OSMのcoastline
// 規約=陸が左・海が右)。segsは「そのタイル近辺だけに絞ったリスト」を渡すこと(全件走査を
// 避けるため、呼び出し元の_fillCoastlineTile参照)。
function isSeaPoint(px, pz, segs) {
  for (const r of coastlineRings) if (pointInPolygon(px, pz, r)) return false; // 島の内側は海ではない
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
// 【2026-08-13・IMPL_PROMPT_20260813_SEA_CLAMP_IN_FARNODEY.md】DEMは水域の上に測定
// されていない正の値を返すため、そのまま描くと海面が地形の下に隠れる(NY実測: 海面11.30
// に対し地形が+0.6〜3)。海岸線から直接「海であり、かつ岸から十分離れている」ノードだけを
// 海面下へ落とす。
//
// 【前々回版(TERRAIN_YIELDS_TO_WATER.md、revert済み)の教訓】余裕を海面ポリゴンの矩形の
// 縁から測っていたため、100m四方の矩形が連なっていても各矩形の縁から40mを引くと中央の20m帯
// しか残らず、ほぼ全ノードが除外されていた(lowered nodes=39という極端に小さい値の原因)。
// 加えて当時のポリゴンは陸を36%巻き込んでいたため、下げた少数のノードが陸に当たり水没した。
// →今回は海岸線そのものから距離を測り、ポリゴンを一切経由せず、coastlineSegsから直接
// 判定する(isSeaPointと同じ最寄り区間+右手側判定のロジックを流用)。
//
// 【前回版(TERRAIN_YIELDS_TO_SEA_V2.md、実装のみでdiscard)の教訓】標高データ(nearElev=
// 543m間隔/wideElev=840m間隔)のノード自体を下げる方式では、下げたノードと陸のノードの間が
// 543mかけて補間され、海の大半がその傾斜帯に入ってしまう(海判定=trueの地点で地形が
// 海面より+5.71残っていた)。→今回は上書きする場所を、データ格子(543m)から描画格子
// (FAR_STEP=200m、part5.js farNodeY)へ移す。標高データ自体は書き換えない(判定が誤っても
// 元に戻せる)。SEA_BED_INSET(岸際を下げない余裕)も、200m格子基準で150mは広すぎたため
// 60mへ縮めた。
//
// 岸際を下げない理由(実測): 地形格子は200m間隔なので、汀線の陸側ノードと海側ノードの間が
// 線形補間になり、岸から200m以内は地形が海面から陸の高さへ滑らかに立ち上がる。ここを
// 下げると汀線が内陸へ食い込む。触らないのが正しい(セル一辺を100→50mにしても残差が
// 全く動かなかったことでこの解釈は確定済み)。
const SEA_BED_INSET = 60;    // 海岸線からこの距離以内のノードは下げない(m)。200m格子では150mは広すぎた
const SEA_BED_DROP  = 0.6;   // 海面(seaLevelY)からこれだけ下に置く
const SEA_BED_FAR   = 3000;  // これより遠い区間は判定に使わない(COAST_DECIDE_MAXと同じ思想)
// 海なら「下げるべき高さ」を、そうでなければnullを返す。川・池には一切関与しない
// (川は地形にドレープする実装で実機合格済み。ここで扱うのは海だけ)。part5.js farNodeYが
// キャッシュ付きで呼ぶ(呼び出し元コメント参照)。
function seaBedYAt(x, z) {
  if (!coastlineSegs || coastlineSegs.length === 0) return null; // 海岸線が無ければ判定しない
  for (const r of coastlineRings) if (pointInPolygon(x, z, r)) return null; // 島の内側は陸
  let best = Infinity, dot = 0;
  for (const s of coastlineSegs) {
    if (s.minX - x > SEA_BED_FAR || x - s.maxX > SEA_BED_FAR ||
        s.minZ - z > SEA_BED_FAR || z - s.maxZ > SEA_BED_FAR) continue; // 粗い枝刈り
    const dx = s.bx - s.ax, dz = s.bz - s.az, len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = s.ax + dx * t, cz = s.az + dz * t;
    const d = (x - cx) * (x - cx) + (z - cz) * (z - cz);
    if (d < best) { best = d; dot = (x - cx) * (-dz) + (z - cz) * dx; }
  }
  if (best === Infinity) return null;              // 近くに海岸線が1本も無い → 判定しない
  if (dot < 0) return null;                        // 陸側
  if (Math.sqrt(best) < SEA_BED_INSET) return null; // 岸際は触らない
  return seaLevelY() - SEA_BED_DROP;
}
// 【2026-08-13・SEA_CLAMP_IN_FARNODEY.md】part5.js farNodeYのキャッシュは遅延評価
// (参照されて初めてseaBedYAtを呼ぶ)なので、放っておくと画面は古いまま。海岸線が更新される
// たび(rebuildCoastlineChains末尾)に低頻度で1回だけ地形メッシュを作り直す。
// 【前版(TERRAIN_YIELDS_TO_SEA_V2.md)からの置き換え】旧scanSeaBedは標高データを直接
// 下げていたためNEAR/WIDEを交互に処理する2段構成だったが、今回はfarNodeY側のキャッシュを
// 無効化するだけなのでupdateFarMesh(true)を1回呼ぶだけでよい(関数名は流用)。
let _seaMeshDirty = true;      // rebuildCoastlineChainsの末尾でtrueにする
let _seaMeshScanFrame = 0;
function scanSeaBed() {
  _seaMeshScanFrame++;
  if (_seaMeshScanFrame % 180 !== 0) return;   // 3秒に1回程度
  if (!_seaMeshDirty) return;
  _seaMeshDirty = false;
  const t0 = performance.now();
  updateFarMesh(true);
  console.log('[seabed] mesh rebuilt (' + (performance.now() - t0).toFixed(0) + 'ms) segs=' +
    (coastlineSegs ? coastlineSegs.length : 0));
}
// 【2026-08-12・COASTLINE_CANDIDATE_SET.md】「見た」印は、実際に判定まで
// たどり着けた時だけ打つ(=候補が0件で早期returnしただけのタイルは保留扱いにし、後で
// coastlineWayStoreが育った時に再試行する)。保留タイルの回収経路と滞留計器を対で持つ
// (大原則「保留を作るなら回収経路と滞留計器を同じコミットで入れる」)。
const pendingCoastlineTiles = new Map(); // key("tx,tz") -> {tx,tz}
let _coastlineRetryFrame = 0;
function scanPendingCoastlineTiles() {
  _coastlineRetryFrame++;
  if (_coastlineRetryFrame % 90 !== 0) return; // scanPendingAreaWaterPolysと同じ周期
  if (pendingCoastlineTiles.size === 0) return;
  const seaY = seaLevelY();
  for (const [, t] of Array.from(pendingCoastlineTiles)) {
    _fillCoastlineTile(t.tx, t.tz, seaY);
  }
  console.log('[coastline] pending=' + pendingCoastlineTiles.size +
    ' store=' + coastlineWayStore.size + ' seen=' + seenCoastlineTiles.size);
}
const COAST_CELL_M = 100;    // 判定セルの一辺。1600mタイル → 16×16
const COAST_DECIDE_MAX = 3000; // この距離内に海岸線が1本も無いタイルは判定せず保留する
// タイル1枚をセル単位で判定して塗る。processCoastlineFill(新規到着バッチ)と
// scanPendingCoastlineTiles(保留の再試行)の両方から呼ばれる。
function _fillCoastlineTile(tx, tz, seaY) {
  const x0 = tx * OSM_TILE_M, x1 = x0 + OSM_TILE_M;
  const z0 = tz * OSM_TILE_M, z1 = z0 + OSM_TILE_M;
  const m = COAST_DECIDE_MAX;
  const segs = coastlineSegs.filter(s =>
    s.minX <= x1 + m && s.maxX >= x0 - m && s.minZ <= z1 + m && s.maxZ >= z0 - m);
  if (segs.length === 0) {
    pendingCoastlineTiles.set(tx + ',' + tz, { tx, tz }); // 判定しない。海岸線が届いてから
    return;
  }
  seenCoastlineTiles.add(tx + ',' + tz);
  pendingCoastlineTiles.delete(tx + ',' + tz);

  const N = Math.round(OSM_TILE_M / COAST_CELL_M);
  const grid = new Uint8Array(N * N);
  let seaCells = 0;
  for (let jz = 0; jz < N; jz++)
    for (let ix = 0; ix < N; ix++) {
      const cx = x0 + (ix + 0.5) * COAST_CELL_M, cz = z0 + (jz + 0.5) * COAST_CELL_M;
      if (isSeaPoint(cx, cz, segs)) { grid[jz * N + ix] = 1; seaCells++; }
    }
  if (seaCells === 0) {
    console.log('[coastline] tile ' + tx + ',' + tz + ': segs=' + segs.length + ' seaCells=0');
    return;
  }
  // 横方向の連続をrunにまとめ、さらに上下で同じrunを矩形に結合する
  // (全部海のタイルは矩形1枚になる。ドローコールを抑えるため)
  const rects = [];
  const doneRow = new Uint8Array(N * N);
  for (let jz = 0; jz < N; jz++)
    for (let ix = 0; ix < N; ix++) {
      if (!grid[jz * N + ix] || doneRow[jz * N + ix]) continue;
      let ex = ix; while (ex + 1 < N && grid[jz * N + ex + 1] && !doneRow[jz * N + ex + 1]) ex++;
      let ez = jz;
      for (;;) { // 下の行が同じ範囲で全部海なら伸ばす
        const nz = ez + 1;
        if (nz >= N) break;
        let same = true;
        for (let k = ix; k <= ex; k++) if (!grid[nz * N + k] || doneRow[nz * N + k]) { same = false; break; }
        if (!same) break;
        ez = nz;
      }
      for (let r = jz; r <= ez; r++) for (let k = ix; k <= ex; k++) doneRow[r * N + k] = 1;
      rects.push({ x0: x0 + ix * COAST_CELL_M, x1: x0 + (ex + 1) * COAST_CELL_M,
                   z0: z0 + jz * COAST_CELL_M, z1: z0 + (ez + 1) * COAST_CELL_M });
    }
  let built = 0, budgetFail = 0;
  for (const r of rects) {
    if (!areaPolyBudgetOK('sea')) { budgetFail++; continue; }
    buildFixedFlatAreaPoly(
      [{ x: r.x0, z: r.z0 }, { x: r.x1, z: r.z0 }, { x: r.x1, z: r.z1 }, { x: r.x0, z: r.z1 }],
      waterAreaMat, seaYOffset(), seaY, null);   // ← holesは不要。島は判定で除外済み
    built++;
  }
  console.log('[coastline] tile ' + tx + ',' + tz + ': segs=' + segs.length +
    ' seaCells=' + seaCells + '/' + (N * N) + ' rects=' + rects.length +
    ' built=' + built + ' budgetFail=' + budgetFail);
}
// data.elements(1バッチ分のOverpass応答)からnatural=coastlineのwayを集めてストアへ入れ、
// chainが古ければ再構築し、tileList(このバッチが対象にしたタイル位置の配列)の各タイルを
// _fillCoastlineTileで判定する。batchKind==='building'はnatural=coastlineを含まないクエリ
// なので何もしない(OSM_TILE_CLAUSES_BUILDING参照)。
let _coastlineNoIdSeq = 0; // 通常のOverpass応答では起きないはずのel.id欠落用フォールバックキー
function processCoastlineFill(elements, tileList) {
  if (!tileList || tileList.length === 0) return;
  if (tileList[0].kind === 'building') return;
  const CLOSE_EPS = 1; // 始点・終点がこの距離(m)以内なら閉じたリング(=島)とみなす
  let newOpen = 0, newIsland = 0;
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    if (!el.tags || el.tags.natural !== 'coastline') continue;
    const pts = el.geometry.map(g => latLonToXZ(g.lat, g.lon));
    const p0 = pts[0], pN = pts[pts.length - 1];
    const closed = pts.length >= 4 &&
      Math.hypot(p0.x - pN.x, p0.z - pN.z) <= CLOSE_EPS;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    const rec = { pts, minX, maxX, minZ, maxZ };
    const id = (el.id !== undefined && el.id !== null) ? el.id : ('noid_' + (_coastlineNoIdSeq++));
    if (closed) {
      coastlineIslandStore.set(id, rec);
      newIsland++;
    } else {
      coastlineWayStore.set(id, rec);
      newOpen++;
    }
    _coastlineChainsDirty = true;
  }
  if (newOpen > 0 || newIsland > 0) {
    console.log('[coastline] batch: openWays=' + newOpen + ' islands=' + newIsland +
      ' tiles=' + tileList.length);
  }
  if (_coastlineChainsDirty) rebuildCoastlineChains();
  const seaY = seaLevelY();
  for (const t of tileList) {
    if (seenCoastlineTiles.has(t.tx + ',' + t.tz)) continue;
    _fillCoastlineTile(t.tx, t.tz, seaY);
  }
}

// buildAreaPolyは元のOSM way頂点(数個)だけで平らな三角形を張るため、起伏のある地形では
// 頂点間で地面から浮いたり埋まったりする(校庭・田畑など、実際に上を歩く地物で顕著)。
// この版はポリゴンの外接矩形をcellSize間隔の格子に分割し、格子点ごとにgetGroundYを
// サンプルするので、地形の起伏に追従する。境界セルはポリゴン外の頂点を含む場合スキップする
// (輪郭がわずかに内側へ痩せるが、実用上は問題ない簡易対応)。
// worldUV=true: UVを世界座標(m)にする(repeatラップの田畑テクスチャ用)。
// worldUV=false: UVをポリゴン外接矩形基準の0..1にする(校庭のトラック等、1枚だけ収めたいテクスチャ用)。
function buildTerrainFollowingAreaPoly(pts, mat, yOff, cellSize, worldUV) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  pts.forEach(p => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); });
  const entry = { mesh: null, kind: 'terrain', areaKind: areaPolyTakePendingKind(), pts, mat, yOff, cellSize, worldUV, minX, maxX, minZ, maxZ };
  // 【2026-07-28】細すぎるポリゴンで諦める時、以前は確保した予算が返らず垂れ流しだった
  if (!_instantiateAreaPolyMesh(entry)) { areaPolyRefund(entry.areaKind); return; }
  areaPolyMeshes.push(entry);
  polyGridAdd(areaPolyGrid, entry);
}

// ======= 【2026-07-28】タイル再取得にあわせた面レコードの破棄 =======
// 公園・水面・田畑・キャンパスの面レコードと、建物回避ポリゴン・土地利用ポリゴンは
// 距離では破棄されない(=データが失われることはない)。ただしタイルを再取得すると
// 同じポリゴンがもう一度積まれ、面メッシュが二重に張られてz-fightingを起こす。
// dropTileRemnants(part1.js)から呼ばれ、そのタイルに属する記録だけを落とす。
// 判定はポリゴンの外接矩形の中心。タイルをまたぐ大きなポリゴン(湾・大河川など)は
// 中心が属する側のタイルにだけ紐づくので、二重にも消え残りにもならない。
function dropAreaRecordsInTile(tx, tz, tileM) {
  // 【2026-08-04・海面塗りの再試行漏れ対策】このタイルの海面ポリゴンを消すなら、
  // seenCoastlineTilesも一緒に忘れさせないと、staleTile再取得後にprocessCoastlineFillが
  // 「もう処理済み」と誤判定して二度と塗り直されない(水域relationで既に踏んだのと同じ罠、
  // [[project_isehara_game_way_tile_attribution]]参照)。
  if (typeof seenCoastlineTiles !== 'undefined') seenCoastlineTiles.delete(tx + ',' + tz);
  const x0 = tx * tileM, x1 = x0 + tileM, z0 = tz * tileM, z1 = z0 + tileM;
  const inTile = (e) => {
    const cx = (e.minX + e.maxX) / 2, cz = (e.minZ + e.maxZ) / 2;
    return cx >= x0 && cx < x1 && cz >= z0 && cz < z1;
  };
  let dropped = 0;
  // (1) 面メッシュ(表示中ならGPUも解放する)
  let w = 0;
  for (const e of areaPolyMeshes) {
    if (inTile(e)) {
      if (e.mesh) { scene.remove(e.mesh); e.mesh.geometry.dispose(); e.mesh = null; } // matは共有なのでdisposeしない
      areaPolyRefund(e.areaKind); // 予算を返す(再取得でまた確保される)
      dropped++; continue;
    }
    areaPolyMeshes[w++] = e;
  }
  if (w !== areaPolyMeshes.length) {
    areaPolyMeshes.length = w;
    areaPolyGrid.clear();
    for (const e of areaPolyMeshes) polyGridAdd(areaPolyGrid, e); // 個別削除より作り直しの方が単純で確実(道路のroadGridと同じ方針)
  }
  // (2) 建物回避ポリゴン
  w = 0;
  for (const e of avoidPolygons) { if (inTile(e)) { dropped++; continue; } avoidPolygons[w++] = e; }
  if (w !== avoidPolygons.length) {
    avoidPolygons.length = w;
    avoidGrid.clear();
    for (const e of avoidPolygons) polyGridAdd(avoidGrid, e);
  }
  // (3) 土地利用ポリゴン(森の描画・地表色の判定に使う)
  if (typeof landusePolygons !== 'undefined' && Array.isArray(landusePolygons)) {
    w = 0;
    for (const e of landusePolygons) { if (inTile(e)) { dropped++; continue; } landusePolygons[w++] = e; }
    if (w !== landusePolygons.length) {
      landusePolygons.length = w;
      if (typeof landuseGrid !== 'undefined' && landuseGrid) {
        landuseGrid.clear();
        for (const e of landusePolygons) polyGridAdd(landuseGrid, e);
      }
    }
  }
  // 【2026-08-03・修正P3(v3 perf)】pendingAreaTrees(森・公園の木のゲート待ち隔離キュー)も
  // 同じ理由でパージする。タイルが作り直される=そのタイルに帰属するwayはun-seeされ
  // 再取得時にhandleAreaFeatureが新しいポリゴンとして積み直すため、古いポリゴン参照を
  // キューに残したままにすると、既に消えた形状の座標へ木を撒く事故になる。
  if (typeof pendingAreaTrees !== 'undefined' && pendingAreaTrees.length) {
    let pw = 0;
    for (const e of pendingAreaTrees) {
      const cx = (e.poly.minX + e.poly.maxX) / 2, cz = (e.poly.minZ + e.poly.maxZ) / 2;
      if (cx >= x0 && cx < x1 && cz >= z0 && cz < z1) { dropped++; continue; }
      pendingAreaTrees[pw++] = e;
    }
    pendingAreaTrees.length = pw;
  }
  // 【2026-08-03・修正B】pendingAreaWaterPolys(水域の予算切れ再試行キュー)も同じ理由で
  // パージする。way単位の水域(handleAreaFeature経由)はタイル再取得でun-seeされ再度
  // handleAreaFeatureが呼ばれるため、古い記述子を残すと予算が空いた時に二重にメッシュが
  // 張られる(z-fighting)。relation単位(processWaterRelation)はseenOSMRelsが現状
  // resetTileForRefetchで解除されないため実際には再処理されないが、念のため同じ扱いにする。
  if (typeof pendingAreaWaterPolys !== 'undefined' && pendingAreaWaterPolys.length) {
    let ww = 0;
    for (const e of pendingAreaWaterPolys) {
      const cx = (e.minX + e.maxX) / 2, cz = (e.minZ + e.maxZ) / 2;
      if (cx >= x0 && cx < x1 && cz >= z0 && cz < z1) { dropped++; continue; }
      pendingAreaWaterPolys[ww++] = e;
    }
    pendingAreaWaterPolys.length = ww;
  }
  return dropped;
}

// ======= 面メッシュの距離ベースGPU解放・再構築 =======
// 【2026-07-17・CODE_REVIEW_20260717 P8】道路(unloadFarRoads/rebuildRoadMesh)と同じ考え方で、
// 公園・水面・田畑・キャンパスの面メッシュも遠方はGPUメッシュだけ解放し、再接近時にentryの
// pts/holes/matから再構築する。avoidPolygons/landusePolygons/minimapWaterPolys(THREE.js
// オブジェクトを持たない軽量な記録)やareaPolyGridへの登録自体は変えない — entry.meshの
// null⇔Meshの切り替えのみ(道路のr.meshと同じパターン)。
const AREA_POLY_UNLOAD_DIST = PERF.roadUnload; // 道路と同程度の距離まで保持
let _areaPolyUnloadFrame = 0;
// force=true: 90フレーム周期を待たず即座に判定する(「今すぐ整理」ボタン用)
function unloadFarAreaPolys(force) {
  if (!worldPosSettled) return; // 開始位置が確定するまで距離を根拠に捨てない(part1.js worldPosSettled参照)
  _areaPolyUnloadFrame++;
  if (!force && _areaPolyUnloadFrame % 90 !== 0) return; // 道路・建物と同様、~1.5秒ごとで十分
  if (areaPolyMeshes.length === 0) return;
  const px = player.position.x, pz = player.position.z;
  const d2 = AREA_POLY_UNLOAD_DIST * AREA_POLY_UNLOAD_DIST;
  for (const entry of areaPolyMeshes) {
    // bboxへの最短距離(プレイヤーがbbox内なら0)。巨大な公園・大河川の中にいるのに
    // 「中心が遠い」という理由で解放されてしまわないようにする。
    const nx = Math.max(entry.minX, Math.min(px, entry.maxX));
    const nz = Math.max(entry.minZ, Math.min(pz, entry.maxZ));
    const dx = px - nx, dz = pz - nz;
    const dd = dx * dx + dz * dz;
    if (!entry.mesh) {
      if (dd <= d2) _instantiateAreaPolyMesh(entry); // 再接近 → 記録から再構築
      continue;
    }
    if (dd <= d2) continue; // まだ範囲内
    scene.remove(entry.mesh);
    entry.mesh.geometry.dispose(); // マテリアルは共有(lawnMat等)なので破棄しない
    entry.mesh = null;
  }
}

// ======= 面ポリゴンレコードの距離破棄(予算の回収) =======
// 【2026-08-01・ユーザー要望「rebuildRoadMesh同様に不要になった水面ポリゴンを回収して再利用する」】
// areaPolyBudget(park/water/farm/campusそれぞれ上限あり)は、これまでdropAreaRecordsInTile
// (=タイル再取得時)でしか返却されなかった。unloadFarAreaPolysはGPUメッシュを解放するだけで
// entry自体(=予算の占有)は生き残り続けるため、二度と戻らない遠方の水面・公園等がbudgetを
// 埋め尽くすと、以降その種別は実形状ポリゴンが一切生成されず回避判定・ミニマップ表示のみに
// フォールバックする(waterの場合「川幅が実際より細い」の主因。areaPolyBudgetOK参照)。
// evictFarRoads(part1.js)と全く同じ考え方で、十分遠いレコードは定期的に配列ごと捨てて
// 予算を返す。KEEP距離はメッシュ保持距離(AREA_POLY_UNLOAD_DIST)よりずっと外側に取り、
// 「まだ見えている・すぐ戻れる」ものは絶対に捨てない。AREA_POLY_UNLOAD_DISTはROAD_UNLOAD_DIST
// と同値(PERF.roadUnload)なので、道路と同じROAD_RECORD_KEEP_DIST(part1.js)をそのまま使う。
// 【トレードオフ】evictFarRoadsと同じく、捨てた範囲へ戻るとそのタイルが取得済み扱いのままなら
// 実形状ポリゴンは復活しない(回避判定・地形自体は別データなので消えない)。KEEP距離は通常の
// 探索範囲のはるか外なので実用上は起きない想定。
const AREA_POLY_RECORD_SOFT_MIN = 300; // これ以下なら走査自体しない(通常プレイでは常にここで抜ける)
let _areaPolyEvictFrame = 0;
let _areaPolyEvicted = 0; // [mem]ログ用(直近ウィンドウの累計)
function evictFarAreaPolys(force) {
  if (!worldPosSettled) return; // 開始位置が確定するまで距離を根拠に捨てない
  _areaPolyEvictFrame++;
  if (!force && _areaPolyEvictFrame % 300 !== 0) return; // evictFarRoadsと同じ~5秒周期(全件走査のため低頻度)
  if (areaPolyMeshes.length < AREA_POLY_RECORD_SOFT_MIN) return;
  const px = player.position.x, pz = player.position.z;
  const keepDist = typeof ROAD_RECORD_KEEP_DIST === 'number' ? ROAD_RECORD_KEEP_DIST : Math.max(6000, AREA_POLY_UNLOAD_DIST * 2);
  const keep2 = keepDist * keepDist;
  let w = 0; // 生存分を前詰めするコンパクション(evictFarRoadsと同じ方針)
  for (let i = 0; i < areaPolyMeshes.length; i++) {
    const e = areaPolyMeshes[i];
    // bboxへの最短距離(unloadFarAreaPolysと同じ判定。巨大な水面・公園の中にいるのに
    // 「中心が遠い」という理由で捨てられないようにする)
    const nx = Math.max(e.minX, Math.min(px, e.maxX));
    const nz = Math.max(e.minZ, Math.min(pz, e.maxZ));
    const dx = px - nx, dz = pz - nz;
    if (dx * dx + dz * dz <= keep2) { areaPolyMeshes[w++] = e; continue; }
    // ここに来る時点でunloadFarAreaPolysが既にメッシュを解放しているはずだが、念のため
    if (e.mesh) { scene.remove(e.mesh); e.mesh.geometry.dispose(); e.mesh = null; }
    areaPolyRefund(e.areaKind); // 予算を返す(再取得でまた確保される)
    _areaPolyEvicted++;
  }
  if (w === areaPolyMeshes.length) return;
  areaPolyMeshes.length = w;
  areaPolyGrid.clear();
  for (const e of areaPolyMeshes) polyGridAdd(areaPolyGrid, e); // 個別削除より作り直しの方が単純で確実(roadGridと同じ方針)
}

function scatterTreesIn(poly, sqmPerTree, cap) {
  const area = (poly.maxX - poly.minX) * (poly.maxZ - poly.minZ);
  const n = Math.min(cap, Math.max(2, Math.floor(area / sqmPerTree)));
  for (let i = 0; i < n; i++) {
    const x = poly.minX + Math.random() * (poly.maxX - poly.minX);
    const z = poly.minZ + Math.random() * (poly.maxZ - poly.minZ);
    if (!pointInPolygon(x, z, poly.pts)) continue;
    // 【2026-08-03・修正P3(v3 perf)】ポリゴン単位のゲート(_areaTreesReady)は「bboxが
    // かかる全タイルが揃うまで」という粗い条件で、数百m〜数kmの森は条件成立がまれなため、
    // 結局タイムアウトで諦めてゲート無しに近い形で撒くことが多かった。木1本ごとに、その
    // 足元のタイルの道路データが確定しているかを直接見る(IMPL_PROMPT_20260803_
    // ROAD_FIDELITY_v3_PERF.md P3)。揃っている場所から自然に埋まり、揃っていない場所は
    // 空くだけ(=忠実性優先の正しい挙動)。撒き漏れた分はpendingAreaTreesの再スキャンで拾う。
    if (!roadReadyTiles.has(osmTileKeyOfXZ(x, z))) continue;
    if (isOnRoad(x, z, 2.5, 2.5)) continue; // 公園・森を横切る道路の上に木が生えないように
    if (isNearWater(x, z, 2)) continue; // 森・公園に隣接/内包する池・川の上に木が生えないように
    addTree(x, z, 0.7 + Math.random() * 0.9);
  }
}

// 【2026-08-03・修正B(暫定緩和)】以前はhandleAreaFeature内でタイル到着と同時に
// scatterTreesInを即座に呼んでいた。ゲート(道路データの到達・距離)が一切無く、
// 5×5先読み(±3200m)の全域に道路より先に木が生え、後から届く道路・線路の位置を
// 手続き建物と同じ理屈で邪魔していた
// (IMPL_PROMPT_20260803_ROAD_FIDELITY_ROOTCAUSE_v2.md M2、
// [[project_isehara_game_way_tile_attribution]]の修正Aとは独立した発生経路)。
// 「本体」(木の散布をgenerateChunk側へ完全移設)ではなく、既存のchunkWaitBuildings/
// tileWaitBuildings(part1.js)と同じ設計の暫定隔離キューで、ゲート成立まで散布を遅らせる。
const pendingAreaTrees = []; // { poly, sqmPerTree, cap, tries }
function queueAreaTrees(poly, sqmPerTree, cap) {
  pendingAreaTrees.push({ poly, sqmPerTree, cap, tries: 0 });
}
// そのポリゴンのbbox全体がかかる全OSMタイルの道路・建物データが揃っており、かつ
// プレイヤーから手続き生成距離(BUILDING_GEN_DIST_PROC)以内か。
function _areaTreesReady(poly) {
  const cx = (poly.minX + poly.maxX) / 2, cz = (poly.minZ + poly.maxZ) / 2;
  const dx = cx - player.position.x, dz = cz - player.position.z;
  if (dx * dx + dz * dz > BUILDING_GEN_DIST_PROC * BUILDING_GEN_DIST_PROC) return false;
  const t0x = Math.floor(poly.minX / OSM_TILE_M), t1x = Math.floor(poly.maxX / OSM_TILE_M);
  const t0z = Math.floor(poly.minZ / OSM_TILE_M), t1z = Math.floor(poly.maxZ / OSM_TILE_M);
  for (let tx = t0x; tx <= t1x; tx++) for (let tz = t0z; tz <= t1z; tz++) {
    const k = tx + ',' + tz;
    if (!roadReadyTiles.has(k) || !buildingReadyTiles.has(k)) return false;
  }
  return true;
}
let _areaTreeScanFrame = 0;
function scanPendingAreaTrees() {
  _areaTreeScanFrame++;
  if (_areaTreeScanFrame % 90 !== 0) return; // 隔離キューと同じ低頻度スキャン(約1.5秒ごと)
  if (pendingAreaTrees.length === 0) return;
  const keep = [];
  for (const e of pendingAreaTrees) {
    e.tries++;
    // 20回(約30秒)待っても揃わなければ諦めて撒く(既存のゲート待ち隔離キューと同じ安全弁。
    // 無限に待ち続けて木が永久に生えない事態を避ける)。
    if (_areaTreesReady(e.poly) || e.tries >= 20) {
      scatterTreesIn(e.poly, e.sqmPerTree, e.cap);
    } else {
      keep.push(e);
    }
  }
  pendingAreaTrees.length = 0;
  for (const e of keep) pendingAreaTrees.push(e);
}

// ======= 明治モード: 迅速測図100m土地利用データ =======
// 出典: 農研機構農業環境研究部門「明治時代初期土地利用・被覆デジタルデータベース」(CC BY 4.0)
// https://github.com/wata909/habs_test — GitHub Pages配信でCORS可、プロキシ不要。
// 100m間隔の点データ。code: 1水田 2畑 3果樹園(桑茶) 4森林 5草地荒地 6村落 7土手崖 8砂地 9湿地 10水面 11竹 12塩田
const meijiCells = new Map();       // "gx,gz"(100m格子) → 土地利用コード
const meijiMeshLoaded = new Set();  // 取得済み二次メッシュ
let meijiReady = false;

// ======= 明治・江戸: 現代建物密度ヒント =======
// 明治・江戸モードでは実OSM建物(神社仏閣以外)は描画しないが、「ここは昔から
// 栄えていた町場だった可能性が高いか」を判定するヒントとして、実際の棟数だけを
// 100m格子で数えておく(建物メッシュは作らないので軽量)。
const modernBuildingDensity = new Map(); // "gx,gz"(100m格子) → 現代建物棟数
function noteModernBuilding(x, z) {
  const k = Math.round(x / 100) + ',' + Math.round(z / 100);
  modernBuildingDensity.set(k, (modernBuildingDensity.get(k) || 0) + 1);
}
function localModernDensity(gx, gz) { // 周辺3×3セル(300m四方)合計(1セル単体のノイズを緩和)
  let n = 0;
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++)
      n += modernBuildingDensity.get((gx + dx) + ',' + (gz + dz)) || 0;
  return n;
}
// 【2026-07-24】8だと現代の中規模な住宅地(300m四方に建物6〜7棟程度)まで「村落」判定に
// 落ち、村落側の軒数(下記generateMeijiCells参照)が少ないせいで明治・江戸モードの
// 町並みが全体的にスカスカに見えるという指摘への対応。閾値を下げ、街道沿いの町家並び
// (generateTownRow。道路沿いに詰めて配置するので体感密度が高い)により多くの区画を回す。
const TOWN_TIER_MIN = 5; // 300m四方の現代建物棟数がこれ以上なら「町場(宿場町・城下町)」ティアとみなす

// 【2026-07-17】meijiMeshCodeはjs/lib/pure.jsへ移動(CODE_REVIEW_20260717 P13-1)。

async function loadMeijiMesh(lat, lon) {
  const { m1, m2 } = meijiMeshCode(lat, lon);
  if (meijiMeshLoaded.has(m2)) return;
  meijiMeshLoaded.add(m2);
  try {
    const res = await fetch(`https://wata909.github.io/habs_test/${m1}/geojson/rapid${m2}.geojson`);
    if (!res.ok) return; // データ未整備地域(404)は空扱いで確定
    const gj = await res.json();
    if (!gj || !gj.features) return;
    for (const f of gj.features) {
      if (!f.geometry || f.geometry.type !== 'Point') continue;
      const code = f.properties && (f.properties.code || f.properties.habs_code);
      if (!code) continue;
      const p = latLonToXZ(f.geometry.coordinates[1], f.geometry.coordinates[0]);
      meijiCells.set(Math.round(p.x / 100) + ',' + Math.round(p.z / 100), code);
      // 森林・竹は読み込み時に低密度で木を散布(恒久インスタンス。プール上限で頭打ち)
      if ((code === 4 || code === 11) && Math.random() < 0.4) {
        const tx = p.x + (Math.random() - 0.5) * 80, tz = p.z + (Math.random() - 0.5) * 80;
        // 街道の上、隣接セルが水面(code10)だった場合のオフセットのはみ出しで池・川の上に
        // 木が生えないように(森林セルの隣が水面セルというケースは山間部の川沿いで頻発)
        if (!isOnRoad(tx, tz, 2.5, 2.5) && !isNearWater(tx, tz, 2))
          addTree(tx, tz, code === 11 ? 0.55 : 0.8 + Math.random() * 0.8);
      }
    }
  } catch (e) { meijiMeshLoaded.delete(m2); } // ネットワーク失敗は再試行可能に
}

async function loadMeijiLanduse() {
  // 江戸: 当時の実測地図が無いため、明治期(迅速測図)データを地形の近似として流用する
  const label = MODE === 'edo' ? t('meijiLanduseEdoLabel') : t('meijiLanduseLabel');
  showToast(`🌾 ${t('meijiLoadingToast', { label })}`, { sticky: true });
  const jobs = [];
  for (const lat of [OSM_BOUNDS.minLat, OSM_BOUNDS.maxLat])
    for (const lon of [OSM_BOUNDS.minLon, OSM_BOUNDS.maxLon])
      jobs.push(loadMeijiMesh(lat, lon));
  await Promise.all(jobs);
  meijiReady = true;
  showToast(`🌾 ${t('meijiLoadedToast', { label, count: meijiCells.size })}`);
}

// ======= 江戸期実データ(街道・町家領域) =======
// 【2026-07-25追加】ROIS-DS人文学オープンデータ共同利用センター(CODH)+株式会社MIERUNE
// 「れきちず」が公開する実測ベースの江戸期データセット(いずれもCC BY 4.0)を、事前に
// Shapefile→JSON変換して同梱したもの(data/edo-roads.json, data/edo-machiya.json。
// 出典: 「江戸主要街道データセット」「『江戸切絵図』町家領域データセット」)。
// 【重要】これらは全国どこでもカバーしているわけではない。街道データは五街道+主要脇街道
// (計37本)のみで、伊勢原周辺の大山道(矢倉沢往還)は含まれない。町家領域データは
// 江戸の御府内(切絵図29枚分。日本橋・神田・芝・麻布・四谷・小石川・深川など中心部)の
// みが対象で、伊勢原はカバーされない。よって伊勢原の生成は従来どおり迅速測図100m
// グリッド+現代密度ヒューリスティックのままで変化せず、実データのある東京中心部・
// 主要街道沿いだけ精度が上がる(=地域ごとに当時の実際の姿へ近づける、という方針どおり)。
const edoMachiyaGrid = new Map(); // polyGridAdd/queryPolyGrid用の空間ハッシュ(町家領域ポリゴン)
const EDO_ROAD_SEG_CELL = 100;
const edoRoadSegGrid = new Map(); // 街道の線分の空間ハッシュ(近接判定専用。可視メッシュ化はしない)
let edoRealDataReady = false;
function edoRoadSegAdd(seg) {
  const gx0 = Math.floor(Math.min(seg.x1, seg.x2) / EDO_ROAD_SEG_CELL), gx1 = Math.floor(Math.max(seg.x1, seg.x2) / EDO_ROAD_SEG_CELL);
  const gz0 = Math.floor(Math.min(seg.z1, seg.z2) / EDO_ROAD_SEG_CELL), gz1 = Math.floor(Math.max(seg.z1, seg.z2) / EDO_ROAD_SEG_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const k = gx + ',' + gz;
    let arr = edoRoadSegGrid.get(k);
    if (!arr) { arr = []; edoRoadSegGrid.set(k, arr); }
    arr.push(seg);
  }
}
// 座標(x,z)から距離maxD以内に実測の江戸期街道が通っているか(宿場町らしさの補強シグナル用)
function nearEdoHistoricalRoad(x, z, maxD) {
  const cellR = Math.max(1, Math.ceil(maxD / EDO_ROAD_SEG_CELL)) + 1;
  const gx = Math.floor(x / EDO_ROAD_SEG_CELL), gz = Math.floor(z / EDO_ROAD_SEG_CELL);
  const d2 = maxD * maxD;
  for (let dx = -cellR; dx <= cellR; dx++) for (let dz = -cellR; dz <= cellR; dz++) {
    const arr = edoRoadSegGrid.get((gx + dx) + ',' + (gz + dz));
    if (!arr) continue;
    for (const s of arr) {
      if (distSqPointToSeg(x, z, s.x1, s.z1, s.x2, s.z2) < d2) return true;
    }
  }
  return false;
}
// 座標(x,z)が「江戸切絵図」実測町家領域(=実際に町人が密集して住んでいた場所)の内側か
function isInEdoMachiyaArea(x, z) {
  for (const p of queryPolyGrid(edoMachiyaGrid, x, x, z, z)) {
    if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
    if (pointInPolygon(x, z, p.pts)) return true;
  }
  return false;
}
async function loadEdoRealData() {
  try {
    const [roadRes, machiyaRes] = await Promise.all([
      fetch('/data/edo-roads.json'),
      fetch('/data/edo-machiya.json'),
    ]);
    const roadData = await roadRes.json();
    const machiyaData = await machiyaRes.json();
    for (const road of roadData.roads) {
      for (const line of road.lines) {
        for (let i = 0; i + 1 < line.length; i++) {
          const a = latLonToXZ(line[i][1], line[i][0]);
          const b = latLonToXZ(line[i + 1][1], line[i + 1][0]);
          edoRoadSegAdd({ x1: a.x, z1: a.z, x2: b.x, z2: b.z });
        }
      }
    }
    for (const sheet of machiyaData.sheets) {
      for (const ring of sheet.rings) {
        const pts = ring.map(([lon, lat]) => latLonToXZ(lat, lon));
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const p of pts) {
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
        }
        polyGridAdd(edoMachiyaGrid, { pts, minX, maxX, minZ, maxZ });
      }
    }
    edoRealDataReady = true;
    console.log(`[edo-real-data] loaded: ${roadData.roads.length} roads, ${machiyaData.sheets.length} machiya sheets`);
  } catch (e) {
    console.warn('[edo-real-data] load failed (falling back to modern-density heuristic only)', e);
  }
}

// 【2026-07-17】thinPts/stitchRings(+_llEq)はjs/lib/pure.jsへ移動(CODE_REVIEW_20260717 P13-1)。

// ======= multipolygon 水面(相模川クラスの大河川) =======
// 大きな水面はOSMでは relation(multipolygon) で表現され、outer が複数wayに
// 分割されていることが多い。stitchRings(js/lib/pure.js)が端点一致で連結して閉リングを組み立てる。
// 【2026-08-03・修正(水域relationの永久ロスト対策)】以前はここ専用の`seenOSMRels`という
// 独立したSetで重複排除しており、resetTileForRefetch(part8.js)が触る`seenOSMRelations`
// (building relation用に既にtile帰属+un-seeの仕組みがある)とは無関係だった。そのため
// 水域relationの面メッシュは、位置ベースのdropAreaRecordsInTile(part4.js)で一度でも
// 消されると(相模川のような広いbboxを持つ大河川では、遠く離れたどこかのタイルが
// staleになるだけで起きうる)、un-seeする手段が無いため二度と復活しなかった
// (「移動するとすぐにリボンになる」報告の実体)。building relationと同じ共有Set
// `seenOSMRelations`を使うことで、既存のtile帰属+un-see経路にそのまま乗せる。
function processWaterRelation(el) {
  if (el.type !== 'relation' || !el.members) return;
  const tags = el.tags || {};
  if (!(tags.natural === 'water' || tags.waterway === 'riverbank' || tags.water)) return;
  if (seenOSMRelations.has(el.id)) return;
  seenOSMRelations.add(el.id);
  const outers = el.members.filter(m => m.type === 'way' && m.role !== 'inner' && m.geometry && m.geometry.length >= 2);
  const inners = el.members.filter(m => m.type === 'way' && m.role === 'inner' && m.geometry && m.geometry.length >= 2);
  const innerRings = stitchRings(inners);
  for (const ring of stitchRings(outers)) {
    // 【2026-08-03 Fable5相談 手順1(診断)】stitchRingsはリングが閉じなかった場合
    // (if (found < 0) break;)、警告もフラグも返さず開いたまま返す。THREE.Shapeはこれを
    // 暗黙に直線で閉じてしまい、大河川では数km級の直線がポリゴンを斜めに横切りうる
    // ——形状の歪みが「輪郭の縫い合わせ」由来か切り分けるためのログ。
    if (ring.length >= 2 && !_llEq(ring[0], ring[ring.length - 1])) {
      console.warn('[water] outer ring not closed after stitchRings:', ring.length, 'pts, relation', el.id);
    }
    let pts = ring.map(g => latLonToXZ(g.lat, g.lon));
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    pts.forEach(p => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); });
    const span = Math.max(maxX - minX, maxZ - minZ);
    if (span < 25) continue;
    const tol = span > 1500 ? 25 : span > 400 ? 10 : 0;
    pts = thinPts(pts, tol);
    if (pts.length < 4) continue;
    const poly = { pts, minX, maxX, minZ, maxZ };
    avoidPolygons.push(poly); // 水面内には建物を生成しない
    polyGridAdd(avoidGrid, poly);
    // このouterのbbox内にある中州(inner)を穴として追加。
    // 【2026-08-03・修正B】以前はareaPolyBudgetOK成功時のみ計算していたが、予算切れでも
    // 再試行キューへ積むために必要なので、holesは無条件で計算する(相模川のような大河川の
    // multipolygonがこの経路。budgetOK失敗時に永久に消えていた不具合の実体)。
    const holes = innerRings
      .map(r => thinPts(r.map(g => latLonToXZ(g.lat, g.lon)), tol))
      .filter(hp => hp.length >= 4 &&
              hp[0].x >= minX && hp[0].x <= maxX && hp[0].z >= minZ && hp[0].z <= maxZ);
    // (2026-07-16: 水面1m下降補正を試したが見た目が崩れたためリバート。+0.15が正)
    if (areaPolyBudgetOK('water')) {
      _commitWaterPoly(pts, holes, minX, maxX, minZ, maxZ);
    } else {
      queueWaterPolyRetry(pts, holes, minX, maxX, minZ, maxZ);
    }
  }
}

// 【2026-07-17】waterwayWidthはjs/lib/pure.jsへ移動(CODE_REVIEW_20260717 P13-1)。
// 川幅の忠実化の経緯(上限300m・est_widthフォールバック・river推定16m)は移動先のコメント参照。

// OSM要素が面フィーチャなら処理して true を返す(初期ロード・タイル両方から呼ばれる)
function handleAreaFeature(el) {
  if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) return false;
  const tags = el.tags || {};
  const lu = tags.landuse || '';
  // riverbank ポリゴン(旧スタイルの川の実形状)も水面として扱う
  const isWater  = tags.natural === 'water' || tags.waterway === 'riverbank';
  // 明治: 現代の公園・田畑・森ポリゴンは使わない(迅速測図データで代替)。川・水面のみ残す
  if (IS_MEIJI && !isWater) return false;
  const isPark   = tags.leisure === 'park' || tags.leisure === 'garden' || tags.leisure === 'playground';
  const isFarm   = ['farmland','farm','orchard','meadow','allotments','vineyard'].includes(lu);
  const isForest = lu === 'forest' || tags.natural === 'wood';
  // 学校・大学・病院の敷地全体(構内に手続き生成の家を建てさせないための回避ゾーン)
  const isCampus = ['school','university','college','hospital'].includes(tags.amenity || '');
  // 【2026-07-18】野球場・サッカー場等の競技用地(leisure=pitch)と陸上競技場(leisure=track)。
  // 種目ごとの見た目はpitchMatFor(sport)/trackMatで割り当てる(定義は上のセクション参照)。
  const isPitch = tags.leisure === 'pitch';
  const isTrack = tags.leisure === 'track';
  if (!isPark && !isWater && !isFarm && !isForest && !isCampus && !isPitch && !isTrack) return false;
  const pts = el.geometry.map(g => latLonToXZ(g.lat, g.lon));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  pts.forEach(p => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); });
  const poly = { pts, minX, maxX, minZ, maxZ };
  avoidPolygons.push(poly);
  polyGridAdd(avoidGrid, poly);
  // 巨大ポリゴンの面メッシュは張らない(頂点間で地形を突き抜けるため)。木は個別に接地するのでOK
  // また面メッシュ=1ドローコールなので種類ごとに総数予算を設ける(超過分は回避領域としてのみ機能)
  const span = Math.max(maxX - minX, maxZ - minZ);
  if (isPark) {
    if (span < 400 && areaPolyBudgetOK('park')) buildTerrainFollowingAreaPoly(pts, lawnMat, 0.14, 20, false);
    if (_areaTreesReady(poly)) scatterTreesIn(poly, 170, 40); else queueAreaTrees(poly, 170, 40);
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    // 【2026-07-28・ユーザー要望で撤去】ベンチ。benchPプール自体はpart2.jsに残している
    // (signBoardP撤去時と同じ方針)が、poolAdd呼び出しをやめたので以降生成されない。
    if (pointInPolygon(cx, cz, pts)) { // 公園灯
      const gy = getGroundY(cx, cz);
      poolAdd(poleP, cx, gy + 2, cz, 0, 0.6, 0.5, 0.6);
      poolAdd(lampP, cx, gy + 4.1, cz, 0, 1, 1, 1, 0xffcc77);
    }
  } else if (isWater) {
    // 【2026-07-16】span上限3000→8000。大河川の岸ポリゴンがスキップされて細いリボンだけに
    // なっていた。大きいものは間引きを強めて頂点数を抑える。
    if (span < 8000) {
      const tp = thinPts(pts, span > 3000 ? 30 : span > 400 ? 10 : 0);
      // 【2026-08-03・修正B】予算切れなら即座に諦めず再試行キューへ(上のpendingAreaWaterPolys参照)。
      if (areaPolyBudgetOK('water')) {
        _commitWaterPoly(tp, null, minX, maxX, minZ, maxZ);
      } else {
        queueWaterPolyRetry(tp, null, minX, maxX, minZ, maxZ);
      }
    }
  } else if (isFarm) {
    if (span >= 15 && span < 500 && areaPolyBudgetOK('farm')) buildTerrainFollowingAreaPoly(pts, farmMat, 0.1, 20, true);
  } else if (isForest) {
    // 【2026-07-19】以前は170(公園)より疎な380=1本1本のまばらな木に見えていた。
    // 森は公園より密なはずなので公園より密度を上げ、上限もTREE_MAX(3500)に対し
    // 十分小さい260に据え置き(1ポリゴンが木プールを独占しないための個別上限。
    // [[feedback_per_building_decoration_budget]]と同じ理由=共有予算は個別に上限が要る)。
    if (_areaTreesReady(poly)) scatterTreesIn(poly, 130, 260); else queueAreaTrees(poly, 130, 260);
  } else if (isCampus) {
    if (span < 900 && areaPolyBudgetOK('campus')) buildTerrainFollowingAreaPoly(pts, campusGroundMat, 0.13, 25, false);
  } else if (isPitch) {
    if (span < 250 && areaPolyBudgetOK('park')) buildTerrainFollowingAreaPoly(pts, pitchMatFor(tags.sport), 0.14, 16, false);
  } else if (isTrack) {
    if (span < 500 && areaPolyBudgetOK('park')) buildTerrainFollowingAreaPoly(pts, trackMat, 0.14, 20, false);
  }
  return true;
}
