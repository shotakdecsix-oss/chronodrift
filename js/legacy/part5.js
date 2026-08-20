/**
 * legacy/part5.js — index.html の巨大インラインスクリプトを行範囲のまま機械的に切り出した
 * ファイル(5/9)。part4.js の続き。詳細は part1.js 冒頭のコメント参照。
 */
// ======= TERRAIN SYSTEM =======
// 【重要・2026-07-14 大改修】以前は「伊勢原専用の詳細地形メッシュ(terrainMesh、常にローカル
// 原点に固定)」と「プレイヤー追従の遠景メッシュ(farMesh、wideElev/nearElevを参照)」の2枚構成
// だった。浮動原点(recenterOrigin)導入後、遠方ジャンプ後はローカル原点付近=常に現在地になる
// ため、詳細メッシュ(伊勢原の地形形状)が現在地の地形・海面に重なって表示される不具合が
// 繰り返し起きた。地域ごとの特別扱いを増やして塞ぐより、そもそも地形描写を1系統に統一する
// 方が保守性が高いため、詳細メッシュを廃止し、farMesh(+wideElev/nearElev)だけを唯一の地形
// メッシュとして伊勢原本体も含め全地域で使う。伊勢原本体の高解像度データは失われない
// (loadNearTerrain/loadWideTerrainは元々、国内なら国土地理院タイル=詳細メッシュと同じ品質の
// データを使っている。part6.js冒頭のコメント参照)。
// 【削除済み】WORLD_W/WORLD_D — 伊勢原専用地形メッシュ廃止(2026-07-14)後、参照ゼロ。
// CODE_REVIEW_20260717 P2で確認・削除。

// 地形の色分けマテリアル(高さ別頂点カラー)。唯一の地形メッシュ(farMesh)がこれを使う。
// polygonOffset: 海岸線(標高≈海面高さ)でfarMeshとseaMesh(part6.js)がほぼ同じ深度値になり、
// GPUの深度バッファ精度の限界でどちらが手前か毎フレーム入れ替わって「ちらつく」(z-fighting)。
// 地形側を深度上だけ少し奥へ押し出す(見た目の頂点位置は変えない)ことで、標高が海面と
// ほぼ同じ場所では常に海面が地形より手前に描かれるようにし、際どい引き分けを無くす。
// 標高が海面よりはっきり高い場所は実際の高低差がこのオフセットよりずっと大きいので、
// 従来どおり地形が正しく手前に来る(海に沈んだように見えたりはしない)。
const terrainMat = new THREE.MeshLambertMaterial({
  vertexColors: true,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4,
});

// 遠景の実地形データ(loadWideTerrain/loadNearTerrain がバックグラウンドで代入)。
// farNodeY が参照するため、初回 updateFarMesh(true) より前に宣言しておく(TDZ回避)。
let wideElev = null;

// ======= 地形メッシュ(プレイヤー追従、全地域共通) =======
// 生成物(道路・建物・プレイヤー)の足元には常にこのメッシュしか存在しないため、
// getGroundY はこのメッシュの表面(farSurfaceY)とだけ厳密に一致していればよい。
const FAR_SIZE = 12000, FAR_SEGS = 60, FAR_SEGS1 = FAR_SEGS + 1; // 半径6km > far(5000) なので端は見えない
const farGeo = new THREE.PlaneGeometry(FAR_SIZE, FAR_SIZE, FAR_SEGS, FAR_SEGS);
farGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(FAR_SEGS1 * FAR_SEGS1 * 3), 3));
const farMesh = new THREE.Mesh(farGeo, terrainMat);
farMesh.rotation.x = -Math.PI / 2;
farMesh.frustumCulled = false; // 頂点変位+移動するためカリングさせない
farMesh.renderOrder = 0;
scene.add(farMesh);

// --- 地形メッシュの高さは farNodeY / farSurfaceY に一本化する ---
// 頂点は世界座標に固定された FAR_STEP(200m) 格子上にあり(中心スナップも FAR_STEP 単位)、
// 「描画されるメッシュ表面」= farSurfaceY が返す値、が厳密に成り立つ。
const FAR_STEP = FAR_SIZE / FAR_SEGS; // 200m
const FAR_Y = -0.15;                  // メッシュ全体のyオフセット

// 格子ノード(i,j)の高さ(メッシュ頂点とクエリの両方がこの1つの関数を使う)。
// NEAR(プレイヤー追従の高解像度グリッド)があればそれを、無ければWIDE(広域低解像度)を、
// どちらも無ければ0mを返す(terrainY内のsampleGridが既にこの優先順位で処理する)。
// 【2026-08-13・IMPL_PROMPT_20260813_SEA_CLAMP_IN_FARNODEY.md】海の下の地形を海面下へ落とす。
// 標高データは543m(NEAR)/840m(WIDE)間隔しかないため、データ格子のノード自体を下げても
// 補間で海の大半が持ち上がってしまう(前版=TERRAIN_YIELDS_TO_SEA_V2.mdで実測: 海判定trueの
// 地点で地形が海面より+5.71残っていた)。描画格子(FAR_STEP=200m)のノードで上書きすることで、
// 汀線の分解能を2.7倍にする。farNodeYはメッシュ構築とgetGroundYの共通入口(このファイル
// 冒頭のコメント「描画されるメッシュ表面=farSurfaceYが返す値、が厳密に成り立つ」参照)なので、
// ここで上書きすれば見た目と当たり判定が構造的に一致する。標高データ(nearElev/wideElev)
// そのものは書き換えない(判定が誤っても元に戻せる)。
//
// 【2026-08-13・IMPL_PROMPT_20260813_SHORELINE_RAMP.md】キャッシュ対象をcoastGeomAtの結果
// (重い、区間を全走査する判定)だけに変更した。高さの計算(seaClampY)は元の地形高さbaseに
// 依存するため毎回行う(baseは地形データの到着で変わるためキャッシュしてはいけない)。
// coastGeomAt自体は海岸線が更新されるとcoastlineVersion(part4.js)が上がり、次に
// 参照されたときだけ再計算される(全消しにすると海岸線バッチのたびに数千点を再計算する
// ことになるため、世代番号だけ見て個別に無効化する)。
const _seaNodeCache = new Map();   // key "i|j" -> { v: coastlineVersion, g: {d,sea}|null }
function farNodeY(i, j) {
  // terrainY はpart6.jsで定義される。このファイル(part5.js)の末尾で行う
  // 起動直後の初期化呼び出し(updateFarMesh(true))はpart6.js読み込み前に実行されるため、
  // 未定義の間は0m(平坦)を返す(ReferenceError回避。typeofは未宣言識別子でも例外を投げない)。
  if (typeof terrainY !== 'function') return 0;
  const base = terrainY(i * FAR_STEP, j * FAR_STEP) || 0;
  if (typeof coastGeomAt !== 'function' || typeof coastlineVersion === 'undefined') return base;
  const k = i + '|' + j;
  let e = _seaNodeCache.get(k);
  if (!e || e.v !== coastlineVersion) {
    e = { v: coastlineVersion, g: coastGeomAt(i * FAR_STEP, j * FAR_STEP) };
    if (_seaNodeCache.size > 40000) _seaNodeCache.clear(); // 移動し続けても際限なく増やさない
    _seaNodeCache.set(k, e);
  }
  return seaClampY(base, e.g);
}
// 【2026-08-03・IMPL_PROMPT_20260803_BRIDGE_WATER_v2.md 修正A-1】farNodeYの`|| 0`と同じ理由で、
// 欠測を区別できるノードクエリを別途用意する(part4.jsの水面プロファイル計算専用)。
function farNodeYOrNull(i, j) {
  if (typeof terrainYOrNull !== 'function') return null;
  return terrainYOrNull(i * FAR_STEP, j * FAR_STEP);
}

// 描画されるメッシュ表面と厳密に一致する高さ(三角形分割もPlaneGeometryと同一)
function farSurfaceY(x, z) {
  const i = Math.floor(x / FAR_STEP), j = Math.floor(z / FAR_STEP);
  const u = x / FAR_STEP - i, v = z / FAR_STEP - j;
  const ha = farNodeY(i, j),     hb = farNodeY(i, j + 1);
  const hc = farNodeY(i + 1, j + 1), hd = farNodeY(i + 1, j);
  const s = (u + v <= 1)
    ? ha + (hd - ha) * u + (hb - ha) * v
    : hc + (hb - hc) * (1 - u) + (hd - hc) * (1 - v);
  return s + FAR_Y;
}

let farLastX = Infinity, farLastZ = Infinity;
function updateFarMesh(force) {
  const cx = Math.round(player.position.x / FAR_STEP) * FAR_STEP;
  const cz = Math.round(player.position.z / FAR_STEP) * FAR_STEP;
  if (!force && cx === farLastX && cz === farLastZ) return;
  farLastX = cx; farLastZ = cz;
  farMesh.position.set(cx, FAR_Y, cz);
  const i0 = Math.round((cx - FAR_SIZE / 2) / FAR_STEP);
  const j0 = Math.round((cz - FAR_SIZE / 2) / FAR_STEP);
  const pos = farGeo.attributes.position, col = farGeo.attributes.color;
  for (let jz = 0; jz < FAR_SEGS1; jz++) {
    for (let jx = 0; jx < FAR_SEGS1; jx++) {
      const idx = jz * FAR_SEGS1 + jx;
      const h = farNodeY(i0 + jx, j0 + jz); // クエリと同じノード関数を使用
      pos.setZ(idx, h);
      if (h > terrainMaxH) terrainMaxH = h; // 色の正規化用の最大高さも同じループで更新(space/edo/marchenモード)
      const c = terrainColorRGB(h);
      col.setXYZ(idx, c[0], c[1], c[2]);
    }
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  farGeo.computeVertexNormals();
}

let elevBase = 0; // このリージョンの高度基準(実標高m)。establishRegionBase(part6.js)が地域ごとに確定する。

// 起伏の倍率
const ELEV_SCALE = 2.0;

// ======= 「見えている地面」の高さ(生成物・プレイヤーはすべてこれを使う) =======
function getGroundY(x, z) {
  return farSurfaceY(x, z);
}

// 高さ→頂点カラー: 緑(低地) → 深緑(山) → 岩 → 雪
let terrainMaxH = 1;
// 岩・雪・森林限界の境界(ゲーム高さ)。実標高(m)基準で establishRegionBase(part6.js)が設定する。
// 実標高基準にして、山は中腹まで緑・森、岩と雪は本当に高い所だけにする。
let ROCK_Y = 1e9, SNOW_Y = 1e9, TREELINE = 1e9;
function terrainColorRGB(h) {
  if (MODE === 'space')   { const t = Math.max(0,Math.min(1,h/terrainMaxH)); const g = 0.15 + t*0.25; return [g*0.9, g, g*1.3]; }
  if (MODE === 'edo')     { const t = Math.max(0,Math.min(1,h/terrainMaxH)); return [0.30 + 0.18*t, 0.27 + 0.10*t, 0.16 + 0.06*t]; }
  if (MODE === 'marchen') { const t = Math.max(0,Math.min(1,h/terrainMaxH)); return [0.28 + 0.42*t, 0.60 - 0.12*t, 0.32 + 0.28*t]; }
  // 現実・明治: 実標高基準。森林限界(約2500m)まで森の緑、2500〜2900mで岩、2900m以上が雪。
  // 大山・丹沢はいずれも2500m未満なので全山が緑=森になる。
  if (h < ROCK_Y) { const k = Math.max(0, Math.min(1, h / Math.max(1, ROCK_Y))); return [0.20 - 0.05*k, 0.34 - 0.07*k, 0.17 - 0.03*k]; } // 低地の緑→山地の深緑
  if (h < SNOW_Y) { const k = (h - ROCK_Y) / Math.max(1, SNOW_Y - ROCK_Y);       return [0.15 + 0.32*k, 0.26 + 0.22*k, 0.13 + 0.22*k]; } // 岩肌
  const k = Math.min(1, (h - SNOW_Y) / Math.max(1, SNOW_Y - ROCK_Y));            return [0.55 + 0.35*k, 0.58 + 0.32*k, 0.56 + 0.38*k];   // 雪
}
// 起動直後も緑の地面で初期化(NEAR/WIDE取得後、updateFarMeshが再サンプリングする)
updateFarMesh(true);

// 同時実行数を絞ってバッチ処理する小さなワーカープール。
// 標高取得を Promise.all で無制限に並列発行していたところ、遠景の高解像度化(WIDE_SEGS増)
// と合わさって一度に最大50件以上の同時リクエストが発生し、プロキシ/サーバーが詰まって
// OSM取得(伊勢原本体)まで巻き添えで失敗する、遠くへジャンプした際に地形取得自体が
// 失敗して何も描写されない、という不具合を起こしていた。同時実行数を小さく固定する。
const FETCH_CONCURRENCY = 3;
async function runLimited(items, worker, limit = FETCH_CONCURRENCY) {
  const results = new Array(items.length);
  let idx = 0;
  async function runNext() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }
  const pool = [];
  for (let n = 0; n < Math.min(limit, items.length); n++) pool.push(runNext());
  await Promise.all(pool);
  return results;
}

// ======= 国土地理院(GSI)標高タイル =======
// opentopodataには「1リクエスト/秒・1リクエスト最大100地点・1日最大1000コール」の制限があり、
// 「地形待ち→道路・建物生成が全部ゲートされて遅い」の根本原因だった。
// 日本国内では国土地理院の標高タイル(dem_png: DEM10B相当、z14、約10mメッシュ)を
// 並列取得する。レート制限・日次上限が無く、地形読み込みが数十秒→数秒になる。
// ・タイルはCORS対応なのでプロキシを通さず直接fetchできる(ブラウザHTTPキャッシュも効く)
// ・日本のカバー範囲外の点が混じるグリッドや、ネットワークエラー時は null を返し、
//   呼び出し側が従来どおり opentopodata へフォールバックする(挙動の安全網は従来のまま)
//
// 【2026-08-19・IMPL_PROMPT_20260819_GSI_DEM_FALLBACK.md】404は「海」ではない。
// GSIの標高タイルはDEM5A/5B/5C(z15)/DEM10B(z14=dem_png)の4種類あり、整備範囲が異なる。
// 東京都心・湾岸はDEM5Aのみ整備でdem_pngは全面404。実測: dem_png/14/14556/6456=404、
// 同一地点の dem5a_png/15/29107/12906 = 3.64m。404を「海」と断定していたため、
// 晴海・豊洲・有明が丸ごとoceanFloorに落ち水没していた。
// 【2026-08-19 v2・IMPL_PROMPT_20260819_GSI_DEM_FALLBACK_v2.md】精度順に並べる。先頭から
// 試し、値が取れた時点で確定する。dem_png(DEM10B)は等高線由来のため、等高線の無い埋立地が
// 周囲の水面(0m)から補間されて潰れる(実測: 晴海三丁目で dem_png=0.5m に対し dem5a=3.64m。
// 真値は3.64m)。「値が返る=正しい」ではないので、精度の低いDEMを先に引いてはいけない。
// dem_pngは最後の保険(DEM5系が未整備な山間部を拾う)として残す。dem5c_pngはログで一度も
// 確定に寄与しなかった(確定=0を連発)ため外す。ここまで到達する点は本物の海であり、海の
// 高さはcoastline判定(part4.js seaClampY)が受け持つので、標高が取れなくてよい。
// 【2026-08-19 v3・IMPL_PROMPT_20260819_GSI_DEM_FALLBACK_v3.md】dem5b_pngも実測で
// 「確定=0」を連発し一度も寄与しなかった(dem5aが無い地域はdem_pngが拾うため中間の5Bは
// 不要と判明)ため削除。3種→2種でリクエストが1/3減る。水の境界の改善(v2の方針)自体は
// 変えない。
const GSI_DEM_SETS = [
  { name: 'dem5a_png', z: 15 },  // 航空レーザ5mメッシュ。都市部・平野部。最優先
  { name: 'dem_png',   z: 14 },  // DEM10B。全国だが低平地の精度が壊滅的。最後の保険
];
const _gsiTiles = new Map(); // "set/tx,ty" -> Promise<Float32Array|null> (null=そのDEMにタイル無し)
const GSI_TILE_CACHE_MAX = 240; // 【2026-08-19】z15はz14の4倍の枚数が要るので120→240
// 【2026-08-19 v3】404(または全ピクセル無効値)だったタイルを永続記憶する。_gsiTilesは
// Float32Array(1枚262KB)を抱えるためGSI_TILE_CACHE_MAXで追い出されるが、「存在しない」
// という事実は軽いので追い出さない。東京湾のように全DEMで欠測する海域は初回に1度404を
// 引くだけで済み、v2で膨れた再取得(毎フレーム同じ404を引き直す)が消える。タイル座標は
// 緯度経度由来の絶対値なので、recenterOriginでクリアしない(地域を移動しても意味が変わらない)。
const _gsiMissing = new Set(); // "set/tx,ty"
function gsiCovers(lat, lon) { return lat >= 20 && lat <= 46 && lon >= 122 && lon <= 154; }
function _gsiLoadTile(set, tx, ty) {
  const key = set.name + '/' + tx + ',' + ty;
  if (_gsiMissing.has(key)) return Promise.resolve(null); // 二度と取りに行かない
  let p = _gsiTiles.get(key);
  if (p) return p;
  p = (async () => {
    const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/${set.name}/${set.z}/${tx}/${ty}.png`);
    if (res.status === 404) { _gsiMissing.add(key); return null; } // このDEMには無い。呼び出し側が次のDEMを試す
    if (!res.ok) throw new Error('GSI HTTP ' + res.status);
    const bmp = await createImageBitmap(await res.blob());
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 256;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    // 【2026-07-28】ImageBitmapはGC任せでは解放が遅く、仕様上もclose()が推奨されている。
    // 1枚256x256x4=262KBで、移動し続けると数百枚単位で作られるため描き込んだ直後に明示解放する。
    bmp.close();
    const d = ctx.getImageData(0, 0, 256, 256).data;
    const out = new Float32Array(65536);
    let valid = 0; // 【2026-08-19 v3】
    for (let i = 0; i < 65536; i++) {
      // 標高 = (R*2^16 + G*2^8 + B) * 0.01m。2^23 は無効値(海など)。それ以上は負値(2^24を引く)
      const x = d[i * 4] * 65536 + d[i * 4 + 1] * 256 + d[i * 4 + 2];
      out[i] = (x === 8388608) ? NaN : (x < 8388608 ? x : x - 16777216) * 0.01;
      if (x !== 8388608) valid++; // 【2026-08-19 v3】
    }
    // 【2026-08-19 v3】タイルは200で返るが中身が全部無効値、という状態が実在する
    // (実測: 豊洲沖)。次回以降このタイルを取りに行かないよう404と同じ扱いにする。
    if (valid === 0) { _gsiMissing.add(key); return null; }
    return out;
  })();
  p.catch(() => _gsiTiles.delete(key)); // 失敗Promiseをキャッシュに残すと永久に失敗し続けるため取り除く
  _gsiTiles.set(key, p);
  if (_gsiTiles.size > GSI_TILE_CACHE_MAX) {
    for (const k of _gsiTiles.keys()) {
      if (_gsiTiles.size <= GSI_TILE_CACHE_MAX) break;
      if (k !== key) _gsiTiles.delete(k);
    }
  }
  return p;
}
// 【2026-08-19】DEM種別ごとにズームが違うので、タイル座標とピクセル座標を種別ごとに求める
function _gsiTileXY(set, lat, lon) {
  const n = 2 ** set.z;
  const xt = (lon + 180) / 360 * n;
  const latR = lat * Math.PI / 180;
  const yt = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
  const tx = Math.floor(xt), ty = Math.floor(yt);
  return { key: set.name + '/' + tx + ',' + ty, tx, ty,
    px: Math.min(255, Math.floor((xt - tx) * 256)),
    py: Math.min(255, Math.floor((yt - ty) * 256)) };
}
// 【2026-08-19 v2】DEM5系が1点も当たらない地域(山間部・離島)では、以降dem_pngを先に試す
// (dem5aの空振りを引いてから回るのを避ける。v3でdem5b削除後もこの学習の意味は同じ)。
// 地域をまたぐと整備状況が変わるので、recenterOrigin(part4.js)でfalseに戻す。
let _gsiPreferWide = false;
function _gsiSetsOrdered() {
  if (!_gsiPreferWide) return GSI_DEM_SETS;
  // 【2026-08-19 v3】dem5b_png削除で2種になったため添字を修正([1]=dem_png, [0]=dem5a_png)。
  return [GSI_DEM_SETS[1], GSI_DEM_SETS[0]];
}
// 【2026-08-19】1つのDEM種別について、まだ値が決まっていない点(idxs)だけを取得する。
// 戻り値 = 次のDEMで再挑戦すべき点のindex配列(=そのDEMにタイルが無かった点)。
// 無効値(水面)と'gsiError'はここで確定させる(再挑戦しない)。
async function _gsiFetchPass(set, latlons, idxs, out) {
  const jobs = idxs.map(i => Object.assign({ i }, _gsiTileXY(set, latlons[i].lat, latlons[i].lon)));
  const tiles = new Map(); // key -> Float32Array | null(タイル無し) | 'error'(取得失敗)
  const keys = [...new Set(jobs.map(j => j.key))];
  await runLimited(keys, async (k) => {
    const j = jobs.find(jb => jb.key === k);
    try {
      tiles.set(k, await _gsiLoadTile(set, j.tx, j.ty));
    } catch (e) {
      try {
        tiles.set(k, await _gsiLoadTile(set, j.tx, j.ty)); // 1回だけリトライ(既存の方針を踏襲)
      } catch (e2) {
        tiles.set(k, 'error'); // このタイルの点だけ呼び出し側でopentopodataに回す
      }
    }
  }, 8);
  const retry = [];
  for (const j of jobs) {
    const tile = tiles.get(j.key);
    if (tile === 'error') { out[j.i] = 'gsiError'; continue; }
    if (tile == null) { retry.push(j.i); continue; }   // ★タイル自体が無い → 次のDEMへ
    const h = tile[j.py * 256 + j.px];
    // 【2026-08-19 v2】無効値(2^23)も次のDEMへ回す。「このDEMでは測っていない」という
    // 意味しかなく、水面とは限らない(実測: dem5aのタイル内無効値率51%、dem_pngは46%)。
    // 全DEMで欠測だった点だけが本物の海として null に落ちる(fetchElevationsGSIのループ末尾)。
    if (!Number.isFinite(h)) { retry.push(j.i); continue; }
    out[j.i] = h;
  }
  if (set.name === 'dem5a_png' && retry.length === idxs.length) _gsiPreferWide = true;
  console.log('[gsiDem] ' + set.name + ': 確定=' + (idxs.length - retry.length) +
              ' 次DEMへ=' + retry.length + ' 既知欠測=' + _gsiMissing.size);
  return retry;
}
// latlons([{lat,lon},...])に対応する標高(m)の配列を返す。データ無し地点(海上)は null、
// 取得失敗(404以外のエラー)地点は 'gsiError'(呼び出し側でopentopodataへ個別補完させる)。
// グリッド全体が使えない場合(国外の点が混じる)だけ null を返す。
// 【2026-07-21・Fable5診断】以前はタイル取得がどれか1枚(404以外の理由で)失敗すると、
// try/catchでグリッド全体をnull扱いにし、呼び出し側が441点まるごとopentopodata
// (1リクエスト/秒・5バッチ逐次)へフォールバックしていた。密集地でNEAR地形の再取得が
// 「たまに」数秒→数十秒規模まで悪化し、その間ずっとchunkNearTerrainReadyが古い窓のまま
// 判定され続け、建物生成が地形待ちで空回りする一因になっていた(実機計測: 生成予算の
// 56%が地形/周辺タイル待ちの再キューで消費されていたことを確認)。エラーをタイル単位に
// 閉じ込め、1回だけリトライしてもダメならそのタイルに属する点だけを後段でopentopodataに
// 回す(全滅ではなく局所的な補完で済む)。
// 【2026-08-19・IMPL_PROMPT_20260819_GSI_DEM_FALLBACK.md】DEM種別を上位から順に多段で試す。
// 【2026-08-19 v2】精度順(dem5a→dem_png)に変更。あるDEMにタイル自体が無い(404)、
// または値はあるが無効値(2^23)の点は、いずれも次のDEMへ回す(v2の§3-2、精度の低いDEMが
// 埋立地等で「値はあるが潰れている」ケースがあるため)。dem5b_pngはv3で削除(§3-1)。
async function fetchElevationsGSI(latlons) {
  if (!latlons.length || !latlons.every(ll => gsiCovers(ll.lat, ll.lon))) return null;
  const out = new Array(latlons.length);
  let pending = latlons.map((_, i) => i);
  for (const set of _gsiSetsOrdered()) {
    if (pending.length === 0) break;
    pending = await _gsiFetchPass(set, latlons, pending, out);
  }
  for (const i of pending) out[i] = null; // 全DEMで404 = 本当にデータが無い(海・国外)
  // 【2026-07-21・国外の誤判定対策】gsiCoversは矩形(緯度20-46°・経度122-154°)による
  // ざっくりした判定で、日本の遠隔離島(沖ノ鳥島・南鳥島・与那国等)を確実に含めるために
  // 広めに取ってある。この矩形は結果的に韓国・北朝鮮・ロシア極東・台湾・中国沿岸の一部も
  // 含んでしまう。これらの地点はGSIタイルが存在しない(404=「データ無し」として仕様通り
  // null扱い)ため、本来は普通の陸地であるにもかかわらず「海上(データ無し)」と誤認され、
  // elevBaseが確定できず既定値0にフォールバックした結果、実標高0mを基準にoceanFloor
  // (-10のゲーム高さ=実標高換算で-5m)一色の平らな「海」として描画されてしまっていた
  // (実機報告: 韓国・北朝鮮・ロシアが標高-5mで固定)。
  // 対策: このバッチ内に実データ(数値)が1点も無く、かつ取得失敗('gsiError')でもない
  // (=正真正銘GSIが「データ無し」と答えた)場合、それは真の日本近海というより「そもそも
  // 日本国外」である可能性が高いと判断し、バッチ全体を無効(null)にしてopentopodata
  // (世界カバレッジ)へフォールバックさせる(呼び出し側の既存ロジックがそのまま使える)。
  // 本当に日本の遠隔離島まわりの外洋(全点データ無しが正しい)の場合はopentopodata側も
  // 同様にデータが無く同じ結果になるだけなので、悪化はしない。
  const hasRealData = out.some(v => typeof v === 'number');
  const hasError = out.some(v => v === 'gsiError');
  if (!hasRealData && !hasError) return null;
  return out;
}
