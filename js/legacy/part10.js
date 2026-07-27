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
let routeLine = null;      // 地面のライン表示(THREE.Line)

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
const ROUTE_LINE_MAX_POINTS = 2000;
function buildRouteLine() {
  if (routeLine) {
    scene.remove(routeLine);
    routeLine.geometry.dispose();
    routeLine.material.dispose();
    routeLine = null;
  }
  if (!routePoints.length) return;
  const step = Math.max(1, Math.ceil(routePoints.length / ROUTE_LINE_MAX_POINTS));
  const verts = [];
  for (let i = 0; i < routePoints.length; i += step) {
    const p = routePoints[i];
    verts.push(p.x, getGroundY(p.x, p.z) + 0.3, p.z);
  }
  const last = routePoints[routePoints.length - 1];
  verts.push(last.x, getGroundY(last.x, last.z) + 0.3, last.z);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x40c0ff, transparent: true, opacity: 0.85 });
  routeLine = new THREE.Line(geo, mat);
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

// ======= ModeRegistry連携: 経路シム中の毎フレーム更新 =======
// GPS追従モード(geoOnUpdate、part9.js)と同じ考え方:ドラッグ中(mouseDown/camTouchId)は
// camYawに触れず、離した間だけ進行方向へなめらかに戻す(指で視界を振り向ける操作を邪魔しない)。
function routeSimOnUpdate(dt) {
  if (!routePaused) routeProgress = Math.min(routeTotalDist, routeProgress + routeSpeed * dt);
  const pt = advanceRouteProgress(routeProgress);
  if (pt) {
    player.position.x = pt.x;
    player.position.z = pt.z;
    if (Math.hypot(pt.dx, pt.dz) > 0.001) {
      const targetYaw = Math.atan2(pt.dx, pt.dz);
      let diff = targetYaw - player.rotation.y;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      player.rotation.y += diff * Math.min(1, dt * 6);
    }
  }
  player.position.y = floorHeightAt(player.position.x, player.position.z, player.position.y);

  const dragging = mouseDown || camTouchId !== null;
  if (!dragging) {
    let camDiff = player.rotation.y - camYaw;
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
const routeSearchBtnEl = document.getElementById('routeSearchBtn');
const routeHintEl = document.getElementById('routeHint');
const routeSearchGroupEl = document.getElementById('routeSearchGroup');
const routeControlsEl = document.getElementById('routeControls');
const routeInfoEl = document.getElementById('routeInfo');
const routeSpeedSliderEl = document.getElementById('routeSpeedSlider');
const routeSpeedLabelEl = document.getElementById('routeSpeedLabel');
const routePlayPauseBtnEl = document.getElementById('routePlayPauseBtn');
const routeEndBtnEl = document.getElementById('routeEndBtn');

if (routeBtnEl && routePanelEl) {
  routeBtnEl.addEventListener('click', () => {
    routePanelEl.classList.toggle('open');
    routeBtnEl.classList.toggle('active', routePanelEl.classList.contains('open'));
  });
}

function updateRouteControlsUI() {
  const active = window.ModeRegistry && ModeRegistry.getActiveMode();
  const playing = !!(active && active.id === 'routesim' && !routePaused);
  if (routePlayPauseBtnEl) routePlayPauseBtnEl.textContent = playing ? '⏸ 一時停止' : '▶ 経路に戻る';
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
  const [startGeo, destGeo] = await Promise.all([geocodeQuery(startQ), geocodeQuery(destQ)]);
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
