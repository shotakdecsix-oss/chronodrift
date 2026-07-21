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
function farNodeY(i, j) {
  // terrainY はpart6.jsで定義される。このファイル(part5.js)の末尾で行う
  // 起動直後の初期化呼び出し(updateFarMesh(true))はpart6.js読み込み前に実行されるため、
  // 未定義の間は0m(平坦)を返す(ReferenceError回避。typeofは未宣言識別子でも例外を投げない)。
  if (typeof terrainY !== 'function') return 0;
  return terrainY(i * FAR_STEP, j * FAR_STEP) || 0;
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
// ・海上などタイルが無い場所は404が正常応答 → 「データ無し」(呼び出し側で海底/0m扱い)
// ・日本のカバー範囲外の点が混じるグリッドや、ネットワークエラー時は null を返し、
//   呼び出し側が従来どおり opentopodata へフォールバックする(挙動の安全網は従来のまま)
const GSI_DEM_Z = 14;
const _gsiTiles = new Map(); // "tx,ty" -> Promise<Float32Array|null> (null=タイル無し/海上)
const GSI_TILE_CACHE_MAX = 120; // 約30MB。超えたら古い順に捨てる(HTTPキャッシュがあるので再取得は速い)
function gsiCovers(lat, lon) { return lat >= 20 && lat <= 46 && lon >= 122 && lon <= 154; }
function _gsiLoadTile(tx, ty) {
  const key = tx + ',' + ty;
  let p = _gsiTiles.get(key);
  if (p) return p;
  p = (async () => {
    const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/dem_png/${GSI_DEM_Z}/${tx}/${ty}.png`);
    if (res.status === 404) return null; // 海上など: タイルが存在しない(正常系)
    if (!res.ok) throw new Error('GSI HTTP ' + res.status);
    const bmp = await createImageBitmap(await res.blob());
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 256;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, 256, 256).data;
    const out = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) {
      // 標高 = (R*2^16 + G*2^8 + B) * 0.01m。2^23 は無効値(海など)。それ以上は負値(2^24を引く)
      const x = d[i * 4] * 65536 + d[i * 4 + 1] * 256 + d[i * 4 + 2];
      out[i] = (x === 8388608) ? NaN : (x < 8388608 ? x : x - 16777216) * 0.01;
    }
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
async function fetchElevationsGSI(latlons) {
  if (!latlons.length || !latlons.every(ll => gsiCovers(ll.lat, ll.lon))) return null;
  const n = 2 ** GSI_DEM_Z;
  const jobs = latlons.map(ll => {
    const xt = (ll.lon + 180) / 360 * n;
    const latR = ll.lat * Math.PI / 180;
    const yt = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
    const tx = Math.floor(xt), ty = Math.floor(yt);
    return { key: tx + ',' + ty, tx, ty,
      px: Math.min(255, Math.floor((xt - tx) * 256)),
      py: Math.min(255, Math.floor((yt - ty) * 256)) };
  });
  // タイル単位に重複排除して並列取得(キャッシュ削除に巻き込まれないようローカルに保持)
  const tiles = new Map(); // key -> Float32Array|null(海上)|'error'(取得失敗)
  const keys = [...new Set(jobs.map(j => j.key))];
  await runLimited(keys, async (k) => {
    const j = jobs.find(jb => jb.key === k);
    try {
      tiles.set(k, await _gsiLoadTile(j.tx, j.ty));
    } catch (e) {
      try {
        tiles.set(k, await _gsiLoadTile(j.tx, j.ty)); // 1回だけリトライ
      } catch (e2) {
        tiles.set(k, 'error'); // このタイルの点だけ呼び出し側でopentopodataに回す
      }
    }
  }, 8);
  const out = jobs.map(j => {
    const tile = tiles.get(j.key);
    if (tile === 'error') return 'gsiError';
    const h = tile ? tile[j.py * 256 + j.px] : NaN;
    return Number.isFinite(h) ? h : null;
  });
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
