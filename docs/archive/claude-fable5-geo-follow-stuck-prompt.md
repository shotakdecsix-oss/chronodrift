# 相談プロンプト: GPS追従モードが「現在地を取得中...」のまま進まない(スマホのChromeブラウザでも再現)

以下をそのままFable 5に貼ってください。

---

three.js製のブラウザゲーム「ChronoDrift」(実世界の地図データをOSM/Overpass APIから取得し、リアルタイムに街を生成して歩き回れるゲーム)に、新しくGPS追従モード(実際にスマホを持って外を歩くと、ゲーム内プレイヤーもリアルタイムでその通りに動く機能)を追加しました。しかし実機テストで、位置情報取得ボタンをタップすると「📡 現在地を取得中...」の表示のまま進まなくなる不具合が解消できていません。何度か仮説を立てて修正しましたが直らず、しかも一度だけ成功した後にまた再現する、という不可解な挙動もあり、新しい目で見てほしいです。

## アプリの構成

- `index.html` + `js/legacy/part1.js`〜`part9.js`(元は1つの巨大なインラインスクリプトを機械的に9分割したもの。グローバルスコープを共有する昔ながらの`<script>`タグの並び読み込みで、ES Modulesではない)
- サーバーは`server/server.js`(Node)、Renderの無料プランにデプロイ(pushで自動デプロイ、15分アクセスが無いとスリープし次回起動に30-45秒かかる既知の挙動あり)
- プレイヤーは`player`(THREE.Group)。実座標(緯度経度)⇔ゲーム内XZ座標の変換は`latLonToXZ`/`xzToLatLon`(`SCALE=111000`固定、`MID_LAT`/`MID_LON`/`COS_LAT`は`let`で可変・原点付け替え可能)。
- 「ゲームプレイモード」を切り替える`ModeRegistry`という軽量レジストリがある(`js/core/mode-registry.js`)。`registerMode({id, onEnter, onExit, onUpdate})`で登録し、`switchMode(id)`で排他的に切り替え、`animate()`ループから毎フレーム`ModeRegistry.update(dt)`が呼ばれる。今回、既存の`explore`(WASD自由移動)モードに加えて`geo`モードを新規追加した。

## 今回追加した機能: GPS追従モード(モードA)

設計判断(ユーザーと事前に合意済み):
- 向き(heading)はDevice Orientation(コンパス)を使わず、直近のGPS移動ベクトルから推定する(iOSの許可ダイアログを増やしたくないため)。
- GPS誤差で建物にめり込むケースは許容し、GPSモード中は水平衝突判定を行わない。

実装:
- 既存の「現在地」ボタン(`geoBtn`、以前は`getCurrentPosition`を1回呼ぶだけでジャンプする仕様だった)を、`watchPosition`による継続追従のトグルに拡張。
- 新モード`geo`を`ModeRegistry`に登録し、`onUpdate`(`geoOnUpdate`、part9.js)で位置・向きを平滑追従させる。

## 症状の推移(この順で仮説→修正→再現テストを繰り返した)

1. **初回デプロイ**: 「現在地」ボタンをタップしても何も起きない、との報告。
2. 権限が「拒否」で固定されているとダイアログが出ずに即エラーになる仮説を立て、`navigator.permissions.query({name:'geolocation'})`で事前チェックし、拒否済みなら案内メッセージを出す実装を追加(`startGeoFollow`を`async`化)。
3. まだ直らず。ユーザーの端末情報が判明: **iPhone、ブラウザはChrome**。症状は「📡 現在地を取得中...」の表示で止まる(成功も失敗もコールバックが呼ばれない)。
4. iOSで「位置情報サービス」がOFF等だと`getCurrentPosition`のtimeoutオプションが効かずコールバックが永久に呼ばれない既知の不具合がある、との情報を踏まえ、JS側でも12秒の手動見張りタイマー(`setTimeout`)を追加。これでも直らない(見張りタイマーのメッセージにすら切り替わらない)、との報告。
5. 「改善しない」との報告を受け、`await navigator.permissions.query(...)`がクリックのユーザー操作(gesture)コンテキストを途切れさせ、直後の`getCurrentPosition`がiOS側で正しく起動しなくなっている疑いから、この事前チェック自体を撤去し、元の同期呼び出しに戻した。**それでも「改善しない」との報告。**
6. ここで重要な情報が判明: **これまではホーム画面に追加した「Webアプリ」として開いてテストしていたが、通常のChromeタブから開いたら許可ポップアップが出て現在地へのジャンプ自体は成功した。ただし継続追従(watchPositionによる追従)はしていない**(現在地ボタンがアクティブ表示に変わらない)。
7. 「ジャンプは成功するが継続追従が定着しない」原因として、ゲーム内原点(`MID_LAT`/`MID_LON`)から実際のGPS座標が300km(`RECENTER_DIST_M`)超離れていると`jumpToLatLon`が`location.reload()`する仕様があり(下記コード参照)、reloadでJS実行環境ごと`watchPosition`の登録が消えるのではと仮説を立て、reload前にlocalStorageへ再開フラグを立て、起動ブートストラップ側でGPS追従を自動再開する処理を追加した。
8. **しかしユーザーから「川崎市にいるので300kmも離れていない」と指摘され、この仮説は誤りだったと判明**(ゲーム内デフォルト原点は伊勢原/東京近辺で、川崎とは数十km程度の距離しかない)。
9. 「追従していない」の具体的な内容を確認したところ、「現在地ボタンが光らず、アクティブ表示にならない」とのことだった。背景色の変化(CSSの`.active`クラス)だけでは分かりにくい可能性を考え、ボタンの文字自体を「🛰 追従中」に変えるよう改修。
10. **直後の再テストで「スマホブラウザでも取得中、、、のままだ」と報告。** つまり、6.で一度は成功していた「通常のChromeタブでのジャンプ」が、7.〜9.の変更を経た後は再び「取得中...」で止まるようになった、ということになる。この一度成功→また失敗という経緯が特に不可解。

## 現在のコード(`js/legacy/part7.js`、GPS関連部分を丸ごと抜粋)

```js
// ======= スマホ等の位置情報から現在地ジャンプ / GPS追従モード(モードA) =======
let geoModeActive = false;
let geoWatchId = null;
let geoLastFixXZ = null;              // 直近のGPS点(向き推定の差分元)。{x, z}
let geoTargetX = 0, geoTargetZ = 0;   // geoOnUpdateが平滑追従する目標点(生のGPS点)
let geoTargetYaw = null;              // 移動ベクトルから推定した向き(未確定はnull)
const GEO_HEADING_MIN_DIST = 3;       // この距離(m)未満の移動では向きを更新しない(ジッター対策)

function onGeoFix(pos) {
  const { lat, lon } = pos.coords;
  const { x, z } = latLonToXZ(lat, lon);
  if (geoLastFixXZ) {
    const dist = Math.hypot(x - geoLastFixXZ.x, z - geoLastFixXZ.z);
    if (dist >= GEO_HEADING_MIN_DIST) {
      geoTargetYaw = Math.atan2(x - geoLastFixXZ.x, z - geoLastFixXZ.z);
      geoLastFixXZ = { x, z };
    }
  } else {
    geoLastFixXZ = { x, z };
  }
  geoTargetX = x; geoTargetZ = z;
  if (leafletMap && playerMarker) playerMarker.setLatLng([lat, lon]);
}

function updateGeoBtnUI() {
  if (!geoBtnEl) return;
  geoBtnEl.classList.toggle('active', geoModeActive);
  geoBtnEl.title = geoModeActive ? t('geoBtnTitleOn') : t('geoBtnTitleOff');
  geoBtnEl.textContent = t(geoModeActive ? 'geoBtnLabelActive' : 'geoBtnLabel');
}

function startGeoFollow() {
  if (!('geolocation' in navigator)) {
    mapHintEl.textContent = t('mapHintGeoUnsupported');
    return;
  }
  if (!window.isSecureContext) {
    mapHintEl.textContent = t('mapHintGeoHttpsOnly');
    return;
  }
  mapHintEl.textContent = t('mapHintGeoFetching');
  let geoFixSettled = false;
  const geoManualTimeout = setTimeout(() => {
    if (geoFixSettled) return;
    geoFixSettled = true;
    console.warn('[geo] getCurrentPosition did not respond within 12s');
    mapHintEl.textContent = t('mapHintGeoTimeout');
  }, 12000);
  navigator.geolocation.getCurrentPosition(
    p => {
      if (geoFixSettled) return;
      geoFixSettled = true; clearTimeout(geoManualTimeout);
      console.log('[geo] getCurrentPosition success', p.coords.latitude, p.coords.longitude);
      geoLastFixXZ = null; geoTargetYaw = null;
      onGeoFix(p);
      // 300km超ならjumpToLatLonがlocation.reload()するので、その場合はGPS追従を
      // 起動ブートストラップ側で自動再開できるようフラグを立てておく
      const _geoDist = Math.hypot((wrapLon(p.coords.longitude) - MID_LON) * SCALE * COS_LAT,
        (p.coords.latitude - MID_LAT) * SCALE);
      if (_geoDist > RECENTER_DIST_M) {
        try { localStorage.setItem('iseharaResumeGeoFollow', '1'); } catch (e) {}
      }
      jumpToLatLon(p.coords.latitude, p.coords.longitude);
      geoWatchId = navigator.geolocation.watchPosition(onGeoFix,
        (err) => console.warn('[geo] watchPosition error', err),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
      geoModeActive = true;
      if (window.ModeRegistry) ModeRegistry.switchMode('geo');
      updateGeoBtnUI();
      mapOverlay.classList.remove('active');
      mapHintEl.textContent = t('mapHintGeoTracking');
    },
    err => {
      if (geoFixSettled) return;
      geoFixSettled = true; clearTimeout(geoManualTimeout);
      console.warn('[geo] getCurrentPosition error', err.code, err.message);
      mapHintEl.textContent = t('mapHintGeoFailed',
        { reason: err.code === 1 ? t('geoPermissionDenied') : err.message });
    },
    { enableHighAccuracy: true, timeout: 10000 });
}

function stopGeoFollow() {
  if (geoWatchId !== null) { navigator.geolocation.clearWatch(geoWatchId); geoWatchId = null; }
  geoModeActive = false;
  geoLastFixXZ = null; geoTargetYaw = null;
  if (window.ModeRegistry) ModeRegistry.switchMode('explore');
  updateGeoBtnUI();
  mapHintEl.textContent = t('mapHintGeoStopped');
}

const geoBtnEl = document.getElementById('geoBtn');
geoBtnEl.addEventListener('click', () => {
  if (geoModeActive) stopGeoFollow(); else startGeoFollow();
});
```

`js/legacy/part9.js`(起動ブートストラップIIFEの末尾。GPS追従の自動再開処理はここに追加した):

```js
(async () => {
  // ...(地形・OSMデータのロード。既存処理、省略)
  await loadOSM();
  if (!isModeSwitch) {
    const loc = await startLocP;
    jumpToLatLon(loc.lat, loc.lon);
  }
  loadNearTerrain(player.position.x, player.position.z);
  loadWideTerrain(player.position.x, player.position.z);

  // ここから今回追加分
  let resumeGeoFollow = false;
  try { resumeGeoFollow = localStorage.getItem('iseharaResumeGeoFollow') === '1'; } catch (e) {}
  if (resumeGeoFollow) {
    try { localStorage.removeItem('iseharaResumeGeoFollow'); } catch (e) {}
    if (typeof startGeoFollow === 'function') startGeoFollow();
  }
})();
```

`js/legacy/part9.js`(新規追加した`geo`モードのonUpdate。WASD入力を無視し、`geoTargetX/Z`・`geoTargetYaw`へ追従する):

```js
const GEO_POS_SMOOTH = 6;
const GEO_YAW_SMOOTH = 4;
function geoOnUpdate(dt) {
  const dx = geoTargetX - player.position.x, dz = geoTargetZ - player.position.z;
  player.position.x += dx * Math.min(1, dt * GEO_POS_SMOOTH);
  player.position.z += dz * Math.min(1, dt * GEO_POS_SMOOTH);
  const isMoving = Math.hypot(dx, dz) > 0.05;
  if (geoTargetYaw !== null) {
    let diff = geoTargetYaw - player.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    player.rotation.y += diff * GEO_YAW_SMOOTH * dt;
    camYaw = player.rotation.y;
  }
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
```

`ModeRegistry.registerMode`呼び出し(part9.js末尾付近):
```js
ModeRegistry.registerMode({ id: 'explore', label: '3D探索', onUpdate: exploreOnUpdate });
ModeRegistry.registerMode({ id: 'geo', label: 'GPS追従', onUpdate: geoOnUpdate });
ModeRegistry.switchMode('explore');
```

参考: `jumpToLatLon`(既存関数、地名検索ジャンプ等から今までも呼ばれてきたもの。GPS追従用に新規に書いたものではない):
```js
const RECENTER_DIST_M = 300000;
function jumpToLatLon(toLat, toLon) {
  toLon = wrapLon(toLon);
  const distFromOrigin = Math.hypot((toLon - MID_LON) * SCALE * COS_LAT, (toLat - MID_LAT) * SCALE);
  if (distFromOrigin > RECENTER_DIST_M) {
    try {
      localStorage.setItem('iseharaResumePos',
        JSON.stringify({ lat: toLat, lon: toLon, yaw: camYaw, rot: player.rotation.y }));
    } catch (e) {}
    if (typeof abortAllOSMFetches === 'function') abortAllOSMFetches();
    setTimeout(() => location.reload(), 50);
    return;
  }
  const pos = latLonToXZ(toLat, toLon);
  const farJump = !wideElev || Math.abs(pos.x - wideCX) > WIDE_W * 0.32 || Math.abs(pos.z - wideCZ) > WIDE_D * 0.32;
  player.position.set(pos.x, 0, pos.z);
  if (typeof resetOSMTileQueueForJump === 'function') resetOSMTileQueueForJump();
  _osmLastPx = pos.x; _osmLastPz = pos.z;
  _osmMoveUx = 0; _osmMoveUz = 0;
  if (playerMarker) playerMarker.setLatLng([toLat, toLon]);
  if (leafletMap) leafletMap.setView([toLat, toLon], leafletMap.getZoom());
  _wideGiveUp = false; _wideFailCount = 0;
  if (farJump) loadWideTerrain(pos.x, pos.z);
  loadNearTerrain(pos.x, pos.z);
  lastAddrX = pos.x; lastAddrZ = pos.z;
  updateAddressDisplay();
  setTimeout(() => mapOverlay.classList.remove('active'), 300);
}
```

## 環境・切り分け済みの事実

- 端末: iPhone(モデル表記は「17e」とユーザーから伝えられたが正確な型番は未確認)、ブラウザ: Chrome for iOS(内部はWebKit/Safariエンジン)。
- ユーザーの実位置は神奈川県川崎市。ゲーム内デフォルト原点(伊勢原・東京近辺)から300km圏内であることを確認済み(=遠方ジャンプによる`location.reload()`は起きない距離)。
- 開発機はWindows。Macが無くSafariのリモートデバッグ(Web Inspector)が使えず、iPhone実機のコンソールログを直接見る手段がない(`console.log`は追加済みだが、開発者がその出力を見られない)。
- 「取得中...」で止まっている間、地図オーバーレイ画面はそのまま表示され続け、**他のボタン(検索ボタン等)は正常に反応する**ことを確認済み(ページ全体がフリーズしているわけではない)。
- 位置情報のOS設定は「アプリ使用中は許可」に設定済み(拒否されていない)。
- 一度だけ、ホーム画面に追加した「Webアプリ」ではなく通常のChromeタブから開いた際に、許可ポップアップが表示されて現在地へのジャンプ自体は成功した実績がある。ただしそのときも継続追従(ボタンのアクティブ表示)は確認できなかった。その後の修正(上記コード)を経て、再度「取得中...」で止まる状態に戻っている。

## 除外できた仮説

1. 権限が「拒否」で固定されている → 除外(OS設定は「アプリ使用中許可」)。
2. `await navigator.permissions.query()`がユーザー操作コンテキストを壊している → 除外を試みたが撤去後も改善せず。
3. iOSの「位置情報サービス」OFFによる既知のtimeout無視バグ → JS側の手動タイマー(12秒)すら発火しないため、少なくとも「JSの`setTimeout`自体が動いていない」という説明では辻褄が合わない(他ボタンは反応するのでイベントループ自体は生きている)。
4. 遠方ジャンプ(300km超)によるreloadで`watchPosition`状態が消える → 除外(川崎市は300km圏内)。

## 知りたいこと

1. 上記のコード(特に`startGeoFollow`のsuccessコールバック内)に、実行が途中で静かに止まる(例外が投げられて以降の行が実行されない)ような見落としはないか。特に`onGeoFix(p)`→距離計算→`jumpToLatLon(...)`→`watchPosition`登録→`ModeRegistry.switchMode('geo')`→`updateGeoBtnUI()`の一連の流れで、途中の関数が未定義/型不整合等で例外を投げている可能性はないか。
2. 「一度は通常のChromeタブでジャンプ成功→その後の変更で再び取得中のまま止まるようになった」という退行が、7.〜9.で追加した具体的などの変更(距離計算・localStorageへのフラグ書き込み・ボタン文字の書き換え)によって最も起きやすいと思うか。
3. Macが無くSafari Web Inspectorが使えない前提で、iPhone実機のJSエラーを開発者側が見られるようにする現実的な方法はあるか(例: 画面上に直接エラーテキストを表示するオンスクリーンコンソール的な仕組みを仕込む等)。
4. `getCurrentPosition`のsuccess/errorどちらも呼ばれず、こちらで仕込んだ`setTimeout`(12秒)すら発火しないという状態は、JS的にどういう状況なら起こり得るか(イベントループ自体は他のクリックに反応しているという条件下で)。

Macが無くiOS実機のライブデバッグができないため、コードレビューベースでの助言が中心になります。よろしくお願いします。
