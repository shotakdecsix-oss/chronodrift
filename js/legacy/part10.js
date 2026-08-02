/**
 * legacy/part10.js — モードB: 経路シミュレーション(FEATURE_GEO_NAV_MODES.md §3)
 *
 * 出発地・目的地を検索→OSRM公開デモサーバー(driving)で経路取得→その経路をカメラが
 * 自動追従する。既存の地名検索(mapSearchInput/searchPlaceJump、part7.js)には一切
 * 手を入れず、完全に独立したUIパネル(#routePanel)として追加する(既存のジャンプ検索を
 * 壊さないため。ジオコーディング部分は同じGSI→Nominatimフォールバックのロジックを
 * このファイル内に複製している)。
 *
 * 【2026-07-27・ユーザー確認済みの設計】
 *  - 自動再生速度: スライダーで調整可能(2〜40m/s = 約7〜144km/h)。
 *  - 長距離ルート: 距離上限を設けず、既存のタイル逐次生成に任せる。
 *  - 経路表示: カメラを沿わせるだけでなく、地面にラインも表示する。
 *  - 一時停止中はWASD自由モード(explore)に切り替わり寄り道でき、再開すると経路上の
 *    一時停止していた地点へ戻る。
 *
 * ルーティング方式は車移動(driving)に統一(OSRM公開デモサーバーをそのまま利用、
 * APIキー登録・自前ホスト不要)。歩行者専用エリアや高架区間の景観の割り切りはFEATURE_GEO_NAV_MODES.md参照。
 */

// ======= ジオコーディング(searchPlaceJumpと同じGSI→Nominatimフォールバックの複製) =======
// 【重要】part7.jsのsearchPlaceJumpを直接使い回さず、あえて複製する。既存の1点ジャンプ検索の
// 挙動を1文字も変えずに残す(ここで見つかった不具合が既存機能に波及しないようにする)ため。
async function geocodeQuery(q) {
  q = (q || '').trim();
  if (!q) return null;
  try {
    const res = await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(q));
    const js = await res.json();
    if (Array.isArray(js) && js.length) {
      const cands = js.filter(f => f.properties && f.properties.title && f.properties.title.includes(q));
      cands.sort((a, b) => {
        const at = a.properties.title, bt = b.properties.title;
        const aExact = at === q ? 0 : 1, bExact = bt === q ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        const aPoi = a.properties.dataSource ? 0 : 1, bPoi = b.properties.dataSource ? 0 : 1;
        if (aPoi !== bPoi) return aPoi - bPoi;
        return at.length - bt.length;
      });
      const best = cands[0];
      if (best && best.geometry && best.geometry.coordinates) {
        return { lat: best.geometry.coordinates[1], lon: best.geometry.coordinates[0], name: best.properties.title };
      }
    }
  } catch (e) {}
  try {
    const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ja&q=' + encodeURIComponent(q));
    const js = await res.json();
    if (Array.isArray(js) && js.length) {
      return { lat: parseFloat(js[0].lat), lon: parseFloat(js[0].lon), name: js[0].display_name || q };
    }
  } catch (e) {}
  return null;
}

// ======= OSRM(driving)経路取得 =======
// 公開デモサーバー。CORS許可済み・APIキー不要。呼び出し頻度は経路検索時のみ(稀)なので
// server.js経由のプロキシは設けず、既存のNominatim検索(searchPlaceJump)と同様クライアント直接fetchにする。
async function fetchOsrmRoute(startLat, startLon, destLat, destLon) {
  const url = `https://router.project-osrm.org/route/v1/driving/${startLon},${startLat};${destLon},${destLat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  const js = await res.json();
  if (!js || js.code !== 'Ok' || !Array.isArray(js.routes) || !js.routes.length) return null;
  const route = js.routes[0];
  const coords = route.geometry && route.geometry.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  return { coords, distance: route.distance, duration: route.duration };
}

// ======= 経路の状態(座標配列・進捗) =======
let routePoints = [];      // {x,z}[] (latLonToXZ済み、フル解像度)
let routeCum = [];         // 各点までの累積距離(m)。routePointsと同じ長さ
let routeTotalDist = 0;    // 経路全長(m)
let routeProgress = 0;     // 現在の走行距離(m)。0〜routeTotalDist
let routeCurIdx = 0;       // advanceRouteProgressが前回止まったセグメント番号(単調増加、毎フレーム0から探さないための足がかり)
let routeSpeed = 10;       // 自動再生速度(m/s)。スライダーで変更
let routePaused = false;   // true=停止中(寄り道中 or 一時停止 or 到着後)
let routeLine = null;      // 地面のライン表示(THREE.Mesh、リボン状。太さの都合でLineではなくMesh)

// 経路を3D空間の座標配列に変換し、区間ごとの累積距離を計算する(移動用、フル解像度のまま)
function buildRoutePoints(coords) {
  routePoints = coords.map(([lon, lat]) => latLonToXZ(lat, lon));
  routeCum = [0];
  for (let i = 1; i < routePoints.length; i++) {
    const d = Math.hypot(routePoints[i].x - routePoints[i - 1].x, routePoints[i].z - routePoints[i - 1].z);
    routeCum.push(routeCum[i - 1] + d);
  }
  routeTotalDist = routeCum[routeCum.length - 1] || 0;
  routeCurIdx = 0;
}

// 走行距離(dist)に対応する経路上の座標と進行方向ベクトルを返す。
// routeCurIdxは前回呼び出し時のセグメント番号を覚えておき、そこから前進方向にだけ探す
// (dist は自動再生中は単調増加のため、長距離ルート(数千〜数万点)でも探索は実質O(1))。
function advanceRouteProgress(dist) {
  if (!routePoints.length) return null;
  if (routePoints.length === 1) return { x: routePoints[0].x, z: routePoints[0].z, dx: 0, dz: 0 };
  if (dist <= 0) {
    const p0 = routePoints[0], p1 = routePoints[1];
    return { x: p0.x, z: p0.z, dx: p1.x - p0.x, dz: p1.z - p0.z };
  }
  if (dist >= routeTotalDist) {
    const n = routePoints.length;
    const p0 = routePoints[n - 2], p1 = routePoints[n - 1];
    return { x: p1.x, z: p1.z, dx: p1.x - p0.x, dz: p1.z - p0.z };
  }
  while (routeCurIdx < routeCum.length - 2 && routeCum[routeCurIdx + 1] < dist) routeCurIdx++;
  while (routeCurIdx > 0 && routeCum[routeCurIdx] > dist) routeCurIdx--;
  const i = routeCurIdx;
  const p0 = routePoints[i], p1 = routePoints[i + 1] || p0;
  const segStart = routeCum[i], segEnd = routeCum[i + 1] != null ? routeCum[i + 1] : segStart;
  const segLen = segEnd - segStart;
  const t = segLen > 0 ? Math.min(1, Math.max(0, (dist - segStart) / segLen)) : 0;
  return {
    x: p0.x + (p1.x - p0.x) * t,
    z: p0.z + (p1.z - p0.z) * t,
    dx: p1.x - p0.x, dz: p1.z - p0.z,
  };
}

// 地面にラインを描画する(視覚的なガイドのみ。移動計算に使うroutePointsはフル解像度のまま
// 別に保持し、描画だけ間引く。長距離ルートで頂点数・getGroundY呼び出し回数が
// 際限なく増えないようにするため)。
// 【2026-07-28修正・ユーザー報告「細すぎる」】THREE.Line(LineBasicMaterial)のlinewidthは
// 多くの環境(Chrome/ANGLE等)で1px固定になり太さの指定が効かない既知の制約があるため、
// makeRoadGeo(part3.js、道路メッシュ)と同じ「中心線から左右に法線オフセットした帯」を
// 面ジオメトリ(リボンメッシュ)で構築し、確実に太く見せる。
const ROUTE_LINE_MAX_POINTS = 2000;
const ROUTE_LINE_WIDTH = 3.5; // メートル。道路(数m幅)と並んでもはっきり見える太さ
const ROUTE_LINE_COLOR = 0x2fd7ff; // 水色(ユーザー指定)
function buildRouteLine() {
  clearRouteLine();
  if (routePoints.length < 2) return;
  const step = Math.max(1, Math.ceil(routePoints.length / ROUTE_LINE_MAX_POINTS));
  const pts = [];
  for (let i = 0; i < routePoints.length; i += step) {
    const p = routePoints[i];
    pts.push({ x: p.x, z: p.z, y: getGroundY(p.x, p.z) + 0.4 });
  }
  const lastP = routePoints[routePoints.length - 1];
  const lx = pts[pts.length - 1];
  if (!lx || lx.x !== lastP.x || lx.z !== lastP.z) {
    pts.push({ x: lastP.x, z: lastP.z, y: getGroundY(lastP.x, lastP.z) + 0.4 });
  }
  if (pts.length < 2) return;

  const halfW = ROUTE_LINE_WIDTH / 2;
  const positions = [];
  const indices = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[i - 1] || pts[i];
    const next = pts[i + 1] || pts[i];
    let dx = next.x - prev.x, dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const nx = -dz, nz = dx; // 進行方向に対する左右法線
    const p = pts[i];
    positions.push(p.x + nx * halfW, p.y, p.z + nz * halfW); // 左端
    positions.push(p.x - nx * halfW, p.y, p.z - nz * halfW); // 右端
    if (i > 0) {
      const a = (i - 1) * 2, b = a + 1, c = i * 2, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  // 【2026-07-28修正・ユーザー報告「道路に埋まってしまっている」】depthWrite:falseとY+オフセット
  // (旧+0.4)だけではrenderOrderの兼ね合いや地形メッシュと解析的なgetGroundY値の局所的なズレで
  // 道路面に埋まって見える箇所が残った。depthTest自体を切ることで、深度バッファの前後関係に
  // 一切左右されず常に手前に描画されるようにする(ナビ用の案内線としては地形に隠れないほうが
  // 実用上望ましいという判断。renderOrderを大きくして他の不透明物より後に描画させる)。
  const mat = new THREE.MeshBasicMaterial({
    color: ROUTE_LINE_COLOR, transparent: true, opacity: 0.92,
    side: THREE.DoubleSide, fog: false, depthWrite: false, depthTest: false,
  });
  routeLine = new THREE.Mesh(geo, mat);
  routeLine.renderOrder = 999;
  scene.add(routeLine);
}

function clearRouteLine() {
  if (routeLine) {
    scene.remove(routeLine);
    routeLine.geometry.dispose();
    routeLine.material.dispose();
    routeLine = null;
  }
}

// 【2026-07-28・ユーザー報告「経路シム中に落ちる(タブごと)」対策】
// WASD/BIRDでの移動は人間が操作するため、必ず立ち止まる・振り返る・引き返す間(たい)が入り、
// タイル取得キュー(osmTileQueue、part8.js)が追いつく余裕が生まれる。経路シムは無人で
// 何分も休みなく一方向へ進み続けるため、この「間」が構造的に存在せず、キューが積み上がる
// 一方になりやすい(BIRDモードの先読み拡張(_fwdKMax、part8.js)は速度の分だけ先読み距離を
// 伸ばす対策だったが、それでも生成自体の処理速度は変わらないため、根本的な解決にはならない)。
// 静的コードレビューでは実機クラッシュの直接原因(メモリリーク等)を確証できなかった過去の経緯
// ([[project_isehara_game_reverse_donut_retry_cap]]参照)もあるため、原因追及よりも「生成が
// 追いついていない時は経路シム側が自発的に減速・停止して追いつかせる」自己制御を優先する。
const ROUTE_QUEUE_BACKLOG_SOFT = 60;  // これを超えたら減速し始める
const ROUTE_QUEUE_BACKLOG_HARD = 150; // これを超えたら完全停止(キューが捌けるまで進めない)

// 【2026-08-02追加・ユーザー要望】視界カメラを「進行方向向き(引っ張りで回転可能)」
// (false、既定=以前からの挙動)と「完全自由」(true、GPS追従モードの自由視界と同じ)から
// 選べるようにする。routeCamModeBtn(下のUI配線)でトグル。
let routeCamFreeLook = false;

// ======= ModeRegistry連携: 経路シム中の毎フレーム更新 =======
// GPS追従モード(geoOnUpdate、part9.js)と同じ考え方:ドラッグ中(mouseDown/camTouchId)は
// camYawに触れず、離した間だけ進行方向へなめらかに戻す(指で視界を振り向ける操作を邪魔しない、
// routeCamFreeLook=falseの時のみ)。
function routeSimOnUpdate(dt) {
  let _throttled = false;
  if (!routePaused) {
    const backlog = (typeof osmTileQueue !== 'undefined') ? osmTileQueue.length : 0;
    let speedFactor = 1;
    if (backlog > ROUTE_QUEUE_BACKLOG_HARD) { speedFactor = 0; _throttled = true; }
    else if (backlog > ROUTE_QUEUE_BACKLOG_SOFT) {
      speedFactor = 1 - (backlog - ROUTE_QUEUE_BACKLOG_SOFT) / (ROUTE_QUEUE_BACKLOG_HARD - ROUTE_QUEUE_BACKLOG_SOFT);
      _throttled = true;
    }
    routeProgress = Math.min(routeTotalDist, routeProgress + routeSpeed * speedFactor * dt);
  }
  if (routeThrottleHintEl) routeThrottleHintEl.style.display = _throttled ? 'block' : 'none';
  const pt = advanceRouteProgress(routeProgress);
  // 【2026-08-02修正・ユーザー報告「キャラの体向きが反対かも」】targetYaw(進行方向ベクトルから
  // 求めた角度)はcamYawの前方定義(-sinθ,-cosθ。updatePlayerCamera/exploreOnUpdate参照)に
  // 合わせた「カメラ用」の規約(Frame B、2026-07-28に視界の逆向きバグを直した時の式そのまま)。
  // 一方、体(player.rotation.y)はexploreモードの向き決定式(atan2(moveX,moveZ)、符号反転なし
  // =Frame A)と同じ規約でなければならず、この2つはちょうど180°異なる別々の値が必要
  // (詳しい経緯はGPS追従モード側の同種修正・part9.js参照)。targetYawはカメラ用のまま残し、
  // 体だけ別に Frame A(bodyYaw = atan2(dx,dz)、符号反転なし)で計算する。
  let targetYaw = null;
  if (pt) {
    player.position.x = pt.x;
    player.position.z = pt.z;
    if (Math.hypot(pt.dx, pt.dz) > 0.001) {
      targetYaw = Math.atan2(-pt.dx, -pt.dz); // カメラ用(Frame B)
      const bodyYaw = Math.atan2(pt.dx, pt.dz); // 体用(Frame A、exploreと同じ規約)
      let diff = bodyYaw - player.rotation.y;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      player.rotation.y += diff * Math.min(1, dt * 6);
    }
  }
  player.position.y = floorHeightAt(player.position.x, player.position.z, player.position.y);

  // 【2026-08-02追加】GPS追従モードと同じくQ/Eキーは常に効かせる(自由視界時の回転手段)。
  if (keys['q']) { camYaw += dt; }
  if (keys['e']) { camYaw -= dt; }
  const dragging = mouseDown || camTouchId !== null;
  // 【2026-08-02変更】以前はplayer.rotation.y(=当時はカメラと同じFrame Bだった)を追いかけて
  // いたが、上の修正でplayer.rotation.yがFrame A(体用)に変わったため、カメラは代わりに
  // targetYaw(Frame B、カメラ用)を直接追いかける。routeCamFreeLook=trueの間は追従自体を止め、
  // ドラッグ/Q・Eキーだけで動く完全自由視界にする(GPS追従モードと同じ設計)。
  if (!routeCamFreeLook && !dragging && targetYaw !== null) {
    let camDiff = targetYaw - camYaw;
    while (camDiff > Math.PI) camDiff -= Math.PI * 2;
    while (camDiff < -Math.PI) camDiff += Math.PI * 2;
    camYaw += camDiff * Math.min(1, dt * 6);
  }

  updatePlayerCamera();

  if (!routePaused && routeProgress >= routeTotalDist) {
    routePaused = true;
    updateRouteControlsUI();
    if (routeInfoEl) routeInfoEl.textContent = (routeInfoEl.textContent || '') + '(到着しました)';
  }
}

if (window.ModeRegistry) {
  ModeRegistry.registerMode({ id: 'routesim', label: '経路シミュレーション', onUpdate: routeSimOnUpdate });
}

// ======= UI配線 =======
const routeBtnEl = document.getElementById('routeBtn');
const routePanelEl = document.getElementById('routePanel');
const routeStartInputEl = document.getElementById('routeStartInput');
const routeDestInputEl = document.getElementById('routeDestInput');
const routeStartGameBtnEl = document.getElementById('routeStartGameBtn');
const routeStartGpsBtnEl = document.getElementById('routeStartGpsBtn');
const routeDestGameBtnEl = document.getElementById('routeDestGameBtn');
const routeDestGpsBtnEl = document.getElementById('routeDestGpsBtn');
const routeStartHistoryChipsEl = document.getElementById('routeStartHistoryChips');
const routeDestHistoryChipsEl = document.getElementById('routeDestHistoryChips');
const routeSearchBtnEl = document.getElementById('routeSearchBtn');
const routeHintEl = document.getElementById('routeHint');
const routeSearchGroupEl = document.getElementById('routeSearchGroup');
const routeControlsEl = document.getElementById('routeControls');
const routeInfoEl = document.getElementById('routeInfo');
const routeThrottleHintEl = document.getElementById('routeThrottleHint');
const routeSpeedSliderEl = document.getElementById('routeSpeedSlider');
const routeSpeedLabelEl = document.getElementById('routeSpeedLabel');
const routePlayPauseBtnEl = document.getElementById('routePlayPauseBtn');
const routeEndBtnEl = document.getElementById('routeEndBtn');
const routeSimBadgeEl = document.getElementById('routeSimBadge');
// 2026-08-02: 速度バー+カメラモード切替の常時HUD(3D画面上、routeSimBadgeの下)。
const routeSpeedHudEl = document.getElementById('routeSpeedHud');
const routeCamModeBtnEl = document.getElementById('routeCamModeBtn');

// 出発地・目的地それぞれ「現在地」「履歴地」タップで確定した場合はここに{lat,lon,name}を保持し、
// startRouteSimでのテキスト検索(geocodeQuery)をスキップする。手入力し直したら破棄する
// (入力欄のテキストと確定済み座標がズレたまま経路検索されるのを防ぐ)。
let routeStartResolved = null;
let routeDestResolved = null;
if (routeStartInputEl) routeStartInputEl.addEventListener('input', () => { routeStartResolved = null; });
if (routeDestInputEl) routeDestInputEl.addEventListener('input', () => { routeDestResolved = null; });

// 【2026-07-28・ユーザー要望で分離】ジャンプ・GPS追従等でゲーム上の現在地(player.position)と
// スマホの実際の居場所(GPS)がズレていることがあるため、2つの別ボタンにする。
function useGameLocationFor(which) {
  const { lat, lon } = xzToLatLon(player.position.x, player.position.z);
  const resolved = { lat, lon, name: 'ゲーム上の現在地' };
  if (which === 'start') { routeStartInputEl.value = '🎮ゲーム上の現在地'; routeStartResolved = resolved; }
  else { routeDestInputEl.value = '🎮ゲーム上の現在地'; routeDestResolved = resolved; }
}
if (routeStartGameBtnEl) routeStartGameBtnEl.addEventListener('click', () => useGameLocationFor('start'));
if (routeDestGameBtnEl) routeDestGameBtnEl.addEventListener('click', () => useGameLocationFor('dest'));

// スマホのGPS現在地(一回きりのgetCurrentPosition。GPS追従モードのwatchPositionとは無関係・併存可)
function useGpsLocationFor(which) {
  if (!('geolocation' in navigator)) { routeHintEl.textContent = 'この端末は位置情報に対応していません'; return; }
  if (!window.isSecureContext) { routeHintEl.textContent = 'GPS取得にはHTTPS接続が必要です'; return; }
  routeHintEl.textContent = 'GPS取得中...';
  navigator.geolocation.getCurrentPosition(
    (p) => {
      const resolved = { lat: p.coords.latitude, lon: p.coords.longitude, name: 'GPS現在地' };
      if (which === 'start') { routeStartInputEl.value = '📡GPS現在地'; routeStartResolved = resolved; }
      else { routeDestInputEl.value = '📡GPS現在地'; routeDestResolved = resolved; }
      routeHintEl.textContent = '';
    },
    (err) => { routeHintEl.textContent = 'GPS取得に失敗しました: ' + (err.code === 1 ? '権限が拒否されました' : err.message); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}
if (routeStartGpsBtnEl) routeStartGpsBtnEl.addEventListener('click', () => useGpsLocationFor('start'));
if (routeDestGpsBtnEl) routeDestGpsBtnEl.addEventListener('click', () => useGpsLocationFor('dest'));

function useHistoryFor(which, h) {
  const resolved = { lat: h.lat, lon: h.lon, name: h.name };
  if (which === 'start') { routeStartInputEl.value = h.name; routeStartResolved = resolved; }
  else { routeDestInputEl.value = h.name; routeDestResolved = resolved; }
}
// 【重要】地名検索ジャンプ(mapSearchInput/searchPlaceJump、part7.js)が使っている履歴
// (iseharaJumpHistory、loadJumpHistory)をそのまま読むだけ(新規の保存先は増やさない)。
function renderRouteHistoryChips() {
  const list = (typeof loadJumpHistory === 'function') ? loadJumpHistory() : [];
  [['start', routeStartHistoryChipsEl], ['dest', routeDestHistoryChipsEl]].forEach(([which, container]) => {
    if (!container) return;
    container.innerHTML = '';
    list.forEach(h => {
      const b = document.createElement('button');
      b.textContent = '🕘 ' + h.name;
      b.addEventListener('click', (e) => { e.stopPropagation(); useHistoryFor(which, h); });
      container.appendChild(b);
    });
  });
}
renderRouteHistoryChips();

if (routeBtnEl && routePanelEl) {
  routeBtnEl.addEventListener('click', () => {
    routePanelEl.classList.toggle('open');
    routeBtnEl.classList.toggle('active', routePanelEl.classList.contains('open'));
    if (routePanelEl.classList.contains('open')) renderRouteHistoryChips(); // 開くたびに最新の履歴を反映
  });
}

// プレイ画面に常時出す経路シム中バッジ(geoFollowBadgeと同じ考え方)。タップでワンタッチ終了できる。
// 【2026-08-02】速度HUD(routeSpeedHudEl)もrouteSimBadgeと同じ条件(経路読み込み中は常時)で
// 表示・非表示を連動させる。
function updateRouteSimBadge() {
  const hasRoute = routePoints.length > 0;
  if (routeSpeedHudEl) routeSpeedHudEl.classList.toggle('show', hasRoute);
  if (!routeSimBadgeEl) return;
  routeSimBadgeEl.classList.toggle('show', hasRoute);
  if (hasRoute) {
    const active = window.ModeRegistry && ModeRegistry.getActiveMode();
    const playing = !!(active && active.id === 'routesim' && !routePaused);
    routeSimBadgeEl.textContent = playing ? '🚗 経路シム再生中' : '🚗 経路シム(一時停止)';
  }
}
if (routeSimBadgeEl) bindTapButton(routeSimBadgeEl, () => { if (routePoints.length > 0) endRouteSim(); });

// 【2026-08-02追加・ユーザー要望】視界カメラモード(進行方向向き⇔完全自由)の切替ボタン。
function updateRouteCamModeBtn() {
  if (!routeCamModeBtnEl) return;
  routeCamModeBtnEl.textContent = routeCamFreeLook ? '🎥 完全自由' : '🎥 進行方向';
  routeCamModeBtnEl.classList.toggle('active', routeCamFreeLook);
}
if (routeCamModeBtnEl) {
  bindTapButton(routeCamModeBtnEl, () => { routeCamFreeLook = !routeCamFreeLook; updateRouteCamModeBtn(); });
  updateRouteCamModeBtn();
}

function updateRouteControlsUI() {
  const active = window.ModeRegistry && ModeRegistry.getActiveMode();
  const playing = !!(active && active.id === 'routesim' && !routePaused);
  if (routePlayPauseBtnEl) routePlayPauseBtnEl.textContent = playing ? '⏸ 一時停止' : '▶ 経路に戻る';
  updateRouteSimBadge();
}

function showRouteControls(distance, duration, startName, destName) {
  if (routeSearchGroupEl) routeSearchGroupEl.style.display = 'none';
  if (routeControlsEl) routeControlsEl.style.display = 'flex';
  if (routeInfoEl) {
    const km = (distance / 1000).toFixed(1);
    const min = Math.round(duration / 60);
    routeInfoEl.textContent = `${startName || ''} → ${destName || ''}(${km}km・約${min}分)`;
  }
  updateRouteControlsUI();
}

async function startRouteSim() {
  const startQ = routeStartInputEl.value.trim();
  const destQ = routeDestInputEl.value.trim();
  if (!startQ || !destQ) { routeHintEl.textContent = '出発地・目的地を入力してください'; return; }
  routeHintEl.textContent = '検索中...';
  // 「現在地」「履歴地」タップで確定済みならテキスト検索(geocodeQuery)をスキップする
  const [startGeo, destGeo] = await Promise.all([
    routeStartResolved || geocodeQuery(startQ),
    routeDestResolved || geocodeQuery(destQ),
  ]);
  if (!startGeo) { routeHintEl.textContent = `「${startQ}」が見つかりませんでした`; return; }
  if (!destGeo) { routeHintEl.textContent = `「${destQ}」が見つかりませんでした`; return; }

  routeHintEl.textContent = '経路検索中...';
  let route = null;
  try { route = await fetchOsrmRoute(startGeo.lat, startGeo.lon, destGeo.lat, destGeo.lon); }
  catch (e) { route = null; }
  if (!route) { routeHintEl.textContent = '経路が見つかりませんでした(車で行けない可能性があります)'; return; }

  buildRoutePoints(route.coords);
  buildRouteLine();
  routeProgress = 0;
  routePaused = false;

  // 【重要】jumpToLatLon(part7.js)は原点から300km超だと現在地・向きを保存してlocation.reload()する
  // (jumpToLatLon内のfar-jump分岐)。reloadされると経路データはメモリごと消えるため、GPS追従モード
  // (iseharaResumeGeoFollow、part7.js startGeoFollow)と全く同じパターンで、reloadが起きる場合だけ
  // 経路データをlocalStorageに保存しておき、このファイル末尾のブート処理で再開させる。
  const distFromOrigin = Math.hypot((wrapLon(startGeo.lon) - MID_LON) * SCALE * COS_LAT, (startGeo.lat - MID_LAT) * SCALE);
  if (distFromOrigin > RECENTER_DIST_M) {
    try {
      localStorage.setItem('iseharaResumeRouteSim', JSON.stringify({
        coords: route.coords, distance: route.distance, duration: route.duration,
        startName: startGeo.name, destName: destGeo.name,
      }));
    } catch (e) {}
  }

  jumpToLatLon(startGeo.lat, startGeo.lon);
  if (window.ModeRegistry) ModeRegistry.switchMode('routesim');
  showRouteControls(route.distance, route.duration, startGeo.name, destGeo.name);
  mapOverlay.classList.remove('active');
}

if (routeSearchBtnEl) routeSearchBtnEl.addEventListener('click', startRouteSim);
[routeStartInputEl, routeDestInputEl].forEach(el => {
  if (!el) return;
  el.addEventListener('keydown', e => {
    e.stopPropagation(); // WASD移動のキー入力ハンドラに拾わせない(mapSearchInputと同じ対策)
    if (e.key === 'Enter') startRouteSim();
  });
  el.addEventListener('keyup', e => e.stopPropagation());
});

if (routeSpeedSliderEl) {
  routeSpeed = parseFloat(routeSpeedSliderEl.value) || routeSpeed;
  routeSpeedSliderEl.addEventListener('input', () => {
    routeSpeed = parseFloat(routeSpeedSliderEl.value);
    if (routeSpeedLabelEl) routeSpeedLabelEl.textContent = Math.round(routeSpeed * 3.6) + ' km/h';
  });
}

// 一時停止↔再開: 停止中はexplore(WASD自由移動)に切り替えて寄り道できるようにし、
// 再開すると経路シムに戻って一時停止していた地点(routeProgress)へ自動的に戻る。
function pauseRouteSimForDetour() {
  routePaused = true;
  if (window.ModeRegistry) ModeRegistry.switchMode('explore');
  updateRouteControlsUI();
}
function resumeRouteSim() {
  routePaused = false;
  if (window.ModeRegistry) ModeRegistry.switchMode('routesim');
  updateRouteControlsUI();
}
if (routePlayPauseBtnEl) {
  routePlayPauseBtnEl.addEventListener('click', () => {
    const active = window.ModeRegistry && ModeRegistry.getActiveMode();
    if (active && active.id === 'routesim' && !routePaused) pauseRouteSimForDetour();
    else resumeRouteSim();
  });
}

function endRouteSim() {
  if (window.ModeRegistry) ModeRegistry.switchMode('explore');
  clearRouteLine();
  routePoints = []; routeCum = []; routeTotalDist = 0; routeProgress = 0; routeCurIdx = 0;
  routePaused = false;
  if (routeControlsEl) routeControlsEl.style.display = 'none';
  if (routeSearchGroupEl) routeSearchGroupEl.style.display = 'flex';
  if (routeHintEl) routeHintEl.textContent = '';
  try { localStorage.removeItem('iseharaResumeRouteSim'); } catch (e) {}
  updateRouteControlsUI(); // routePoints.length===0になったのでバッジも隠れる(updateRouteSimBadge経由)
}
if (routeEndBtnEl) routeEndBtnEl.addEventListener('click', endRouteSim);

// ======= ブート時の経路シム再開 =======
// 出発地が原点(MID_LAT/MID_LON)から300km超だとjumpToLatLonがlocation.reload()するため
// (startRouteSim側の分岐参照)、そのreload後にここで検知して経路データを復元し、
// 自動的に経路シムを再開する(GPS追従モードのiseharaResumeGeoFollowと同じ役割)。
// 【重要】このファイル(part10.js)はpart9.js(ブート処理・loadOSM本体)より後に読み込まれるため、
// part9.js側の起動処理(recenterOrigin・player.position確定)は既に完了している。
(function tryResumeRouteSim() {
  let saved = null;
  try {
    const s = localStorage.getItem('iseharaResumeRouteSim');
    if (s) { localStorage.removeItem('iseharaResumeRouteSim'); saved = JSON.parse(s); }
  } catch (e) {}
  if (!saved || !Array.isArray(saved.coords)) return;
  buildRoutePoints(saved.coords);
  buildRouteLine();
  routeProgress = 0;
  routePaused = false;
  if (window.ModeRegistry) ModeRegistry.switchMode('routesim');
  showRouteControls(saved.distance, saved.duration, saved.startName, saved.destName);
  if (routePanelEl) routePanelEl.classList.add('open');
  if (routeBtnEl) routeBtnEl.classList.add('active');
})();
