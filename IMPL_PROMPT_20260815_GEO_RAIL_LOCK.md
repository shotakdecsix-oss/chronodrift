# 実装指示: GPS追従モードに「線路ロック」オプションを追加

対象リポジトリ: `C:\Users\Shoichi\Desktop\isehara-game`
作成日: 2026-08-15

---

## 0. 前提 — なぜこの機能が要るのか（調査済み・再調査不要）

GPS追従モード（モードA）で**電車に乗ると、キャラが線路ではなく並走する道路の上に乗る**という不具合報告があった。2026-08-15に切り分け済みで、結論は以下のとおり。**この前提を疑い直すことに時間を使わないこと。**

- コード上に道路スナップ処理は**存在しない**。`onGeoFix`（`js/legacy/part7.js` 約395行）は `pos.coords` を `latLonToXZ()` で変換するだけで、`roadRecords` を一切参照していない。`geoOnUpdate`（`js/legacy/part9.js` 約826行）も水平方向は外挿＋指数平滑のみ。
- 実機確認で、**ミニマップ（Leaflet）のマーカーも道路上にいた**。ミニマップは生の `pos.coords` を OSM タイルに打つだけなので、**ブラウザから渡ってくる緯度経度そのものが既に道路上**と確定した。
- 追従速度は実際の電車速度に追いついていた。`GEO_MAX_SPEED = 8` のクランプは症状の主因ではない。

真因は Android Fused Location Provider（iOS の同等機能）の **road snapping**。車両移動と判定すると測位値を最寄り道路の中心線へ吸着させる仕様で、Web Geolocation API に無効化手段は無い（`enableHighAccuracy` / `maximumAge` では止まらない）。**OS側の補正はアプリから抑止できない。**

したがって本実装は「OSが道路へ吸着した座標を、こちら側で最寄りの線路へ引き戻す」という**対症療法**である。それを承知の上で、ユーザーが明示的にONにした時だけ働くオプション機能として実装する。

---

## 1. 実装するもの（スコープ）

GPS追従モード中だけ使える **「🚃 線路ロック」トグル**。ONの間、GPSフィックスのXZ座標を最寄りの線路セグメントへ垂線投影してから追従に流す。

**スコープ外（今回はやらない）:**

- 速度による自動ON判定。誤発動と切り分けの難しさを避け、**手動トグルのみ**とする。
- 経路シム（モードB / `part10.js`）への適用。GPS追従モードだけが対象。
- 「電車でGO」的な走行シミュレーション。あくまで実GPSの補正である。

---

## 2. 使えるデータ構造（調査済み）

線路はすでにクライアント側に読み込まれている。新規のデータ取得は不要。

- `roadRecords`（`js/legacy/part1.js` 約673行）: 道路も線路も同じ配列に入る。線路のレコードは
  `{ x1, z1, x2, z2, type: 'railway', rw: 5, mesh, mat, yOff, wid }` の形。
  投入元は `js/legacy/part8.js` 約454行の `addRoad(a.x, a.z, b.x, b.z, 4, 'railway', null, el.id)`。
  `wid` は OSM の way ID なので、**同一路線の連続性判定に使える**。
- `roadGrid`（`part1.js` 約677行）: `ROAD_CELL = 40` m四方の空間ハッシュ。キーは `` `${gx},${gz}` ``、値はレコード配列。1本の線分が複数セルに登録される。近傍検索はこれを使うこと（`roadRecords` 全件走査は禁止。数万件になる）。
- `unloadFarRoads`（`part1.js` 約1210行）は `r.mesh` を破棄して `null` にするだけでレコードは残す。プレイヤー至近（本機能が見る半径80m）のレコードは常に生きている。

**注意:** `part7.js` は `part1.js` より後に読まれるので `roadGrid` / `ROAD_CELL` はそのまま参照できる。読み込み順を変えないこと。

---

## 3. 詳細仕様

### 3-1. 状態と定数（`js/legacy/part7.js`、GPS追従関連の定数群の近くに追加）

```js
let railLockOn = false;      // ユーザーがトグルをONにしているか
let railLockOk = false;      // 直近のフィックスで実際に線路へスナップできたか（UI表示用）
let railLockLastWid = null;  // 直前にスナップした線路の way ID（連続性ボーナス用）
let railLockDir = null;      // 直近スナップ時の線路方向（正規化ベクトル {x, z}）。向き決定に使う

const RAIL_SNAP_MAX_DIST = 80;   // この距離(m)以内に線路が無ければスナップしない
const RAIL_SAME_WAY_BONUS = 0.6; // 直前と同じwidのセグメントは距離をこの倍率で評価（並走路線のちらつき防止）
const GEO_MAX_SPEED_RAIL = 60;   // 線路ロックON中の速度推定上限(m/s)。216km/h相当（新幹線も想定）
```

### 3-2. スナップ関数（`part7.js` に新規追加）

```js
// (x, z) から半径 RAIL_SNAP_MAX_DIST 以内で最も近い線路セグメントへ垂線投影する。
// 見つからなければ null。返り値 { x, z, wid, dirX, dirZ }
function snapToRail(x, z) { ... }
```

要件:

- `roadGrid` を使い、`Math.ceil(RAIL_SNAP_MAX_DIST / ROAD_CELL)` セル分（=±2セル、5×5=25セル）だけ走査する。
- `r.type === 'railway'` **のみ**を対象にする（`'water'` や道路種別は絶対に含めない）。
- 各セグメントについて点と線分の最短距離を求める。媒介変数 `t` は **0〜1 にクランプ**する（線分の外側へ外挿しない）。
- 評価距離 = 実距離 × (`r.wid === railLockLastWid` なら `RAIL_SAME_WAY_BONUS` else 1.0)。この評価距離が最小のものを選ぶ。
- 実距離が `RAIL_SNAP_MAX_DIST` を超えるものしか無ければ `null` を返す。
- 同じレコードが複数セルに登録されているため、**同一レコードを二重評価しないよう `Set` で除外**すること（性能ではなく可読性のため。二重評価しても結果は変わらないが、走査数がセル数ぶん膨らむ）。
- 方向ベクトルは `(x2-x1, z2-z1)` を正規化したもの。符号（どちら向きに進んでいるか）はここでは決めない。

### 3-3. `onGeoFix` への組み込み（`part7.js` 約395行〜）

`const { x, z } = latLonToXZ(lat, lon);` の**直後**に、以下を挿入する（速度推定・`geoAnchor` 更新・向き推定より前。以降の計算はすべてスナップ後の座標で行う）。

```js
let px = x, pz = z;
if (railLockOn) {
  const s = snapToRail(px, pz);
  if (s) {
    px = s.x; pz = s.z;
    railLockLastWid = s.wid;
    railLockDir = { x: s.dirX, z: s.dirZ };
    railLockOk = true;
  } else {
    railLockOk = false;   // 線路が見つからない: 生座標のまま通す（フォールバック）
  }
} else {
  railLockOk = false; railLockLastWid = null; railLockDir = null;
}
```

以降、既存コードの `x` / `z` の参照をすべて `px` / `pz` に置き換える（速度推定、`geoAnchorX/Z`、`geoLastFixXZ`、`geoTargetYaw` の差分計算）。

**ミニマップのマーカーもスナップ後の座標にする**（3D側と位置を一致させる）。`playerMarker.setLatLng([lat, lon])` を、`xzToLatLon(px, pz)` で戻した緯度経度に変更する。ただし**切り分けができなくなるのを避けるため、`console.log` には生の `lat/lon` とスナップ後の両方、および `railLockOk` を出す**こと（フィックスごとに1行。実機デバッグの生命線になる）。

### 3-4. 速度クランプの切り替え（`part7.js`）

現在の `const GEO_MAX_SPEED = 8;` による固定クランプを、ロック状態で切り替わるようにする。

```js
const maxSpeed = railLockOn ? GEO_MAX_SPEED_RAIL : GEO_MAX_SPEED;
if (speed > maxSpeed) { const s = maxSpeed / speed; vx *= s; vz *= s; }
```

`GEO_MAX_SPEED = 8` の定数自体と、それが「早歩き〜軽いジョグ想定」であるコメントは残すこと。

### 3-5. 体の向きを線路方向に合わせる（`js/legacy/part9.js` `geoOnUpdate`）

**電車内はコンパスが車体の金属で狂う**ため、ロック成功中は線路方向を優先する。

`effectiveYaw` を決めている箇所（`part9.js` 約840行、コンパス優先／`geoTargetYaw` フォールバックの分岐）の**前**に、以下の優先枝を足す:

- `railLockOn && railLockOk && railLockDir` が成立するとき、`railLockDir` から向きを作る。
- 進行方向の符号は、直近の推定速度ベクトル `(geoVelX, geoVelZ)` と `railLockDir` の**内積の符号**で決める（内積が負なら方向ベクトルを反転）。速度がほぼ0（`Math.hypot(geoVelX, geoVelZ) < 0.5`）のときは**直前の符号を保持**する（停車中に向きが反転しないよう、符号を状態として持つこと）。
- 得られた向きは既存の `effectiveYaw` と**同じ規約（Frame B / camYaw用）**に揃えること。既存の `geoTargetYaw` は `Math.atan2(-dx, -dz)` で作られている（`part7.js` 約425行）。同じ式を使えば規約は揃う。
- `geoOnUpdate` 側で `bodyYaw = effectiveYaw + Math.PI`（Frame A へ変換）している既存処理はそのまま通す。**この2つの規約の違いは過去に何度もバグを生んでいるので、独自の符号調整を新たに発明しないこと**（`project_isehara_game_body_vs_camera_yaw_convention` 参照）。

camYaw（視界）は自由回転のまま。**触らないこと。**

### 3-6. UI（`index.html` + `part7.js` + i18n）

既存の `#geoFollowBadge`（`index.html` 427行）と同じ作法で、その**直下に積むトグルバッジ**を追加する。

```html
<button id="railLockBadge" type="button" class="glass" data-i18n="railLockBadgeLabel" data-i18n-title="railLockBadgeTitle">🚃 線路ロック</button>
```

- CSS は `#geoFollowBadge` / `#routeSimBadge` のスタイルを踏襲し、`top` だけ `#geoFollowBadge` の下にずらす。`display:none` を既定にし、`.show` で表示。
- **表示条件**: `geoModeActive === true` のときだけ `.show`。`updateGeoBtnUI()`（`part7.js` 約443行）内で `geoFollowBadgeEl` と一緒にトグルする。
- **ON時の見た目**: `.active` クラスで `#altKeepBtn.active` と同じ配色（`rgba(139,123,255,0.45)` / `border-color:var(--accent)`）。
- **3状態のラベル**（ユーザーが「効いているか」を画面だけで判断できるようにする。これは必須要件）:
  - OFF: `🚃 線路ロック`（通常配色）
  - ON かつ `railLockOk === true`: `🚃 線路ロック中`（アクティブ配色）
  - ON かつ `railLockOk === false`: `🚃 線路を探索中`（アクティブ配色＋`opacity:.6`）
  - 状態の反映は `geoOnUpdate` 内で毎フレームやらず、`onGeoFix` のたび（＝数秒に1回）に更新すること。
- **イベント登録**: `bindTapButton`（`part1.js` 2207行）を使う。`click` 直付けは使わない（過去にスマホで反応しない不具合があった）。タップで `railLockOn` を反転し、OFFにしたときは `railLockLastWid = null; railLockDir = null; railLockOk = false;` をリセットする。
- **強制解除**: `stopGeoFollow()`（`part7.js` 約542行）で `railLockOn = false` とリセットを必ず行う。GPS追従を抜けたのにロック状態が残るのは禁止。
- **i18n**: 日本語（`part1.js` 約97行）と英語（約205行）の両方の辞書に `railLockBadgeLabel` / `railLockBadgeLabelActive` / `railLockBadgeLabelSearching` / `railLockBadgeTitle` を追加する。英語は `🚃 Rail Lock` / `🚃 Rail Locked` / `🚃 Seeking rail` / `Tap to toggle` 相当。

---

## 4. 既知の限界（実装してよい／直そうとしないこと）

以下は仕様上の割り切り。ユーザーと合意済みなので、これを潰すための追加機構を勝手に作らないこと。

- **駅構内など線路が並列している場所**では隣のホームの線路に乗ることがある。`RAIL_SAME_WAY_BONUS` による連続性で緩和するのみ。
- **線路データが未ロードの区間**ではスナップできない（電車の速度だとタイル取得が追いつかない場面がある）。生座標フォールバック＋「探索中」表示で見えるようにするだけでよい。
- **下車後にロックを切り忘れる**と歩行位置が線路に吸われる。バッジが常時見えているので手動で切れる、という設計で割り切る。
- スナップは**線路の中心線**に乗せるので、複線区間では上下線の中央ではなく片側の線路上になる。問題ない。

---

## 5. 完了条件

1. GPS追従モードに入ると「🚃 線路ロック」バッジが出る。追従を解除すると消える。
2. タップでON/OFFが切り替わり、配色とラベルが3状態を正しく表示する。
3. ONの間、線路から80m以内にいるときはキャラ位置が線路上に乗り、ミニマップのマーカーも同じ位置に来る。
4. 線路が無い場所ではロックONのままでも生GPS位置で普通に動く（フリーズ・ワープしない）。
5. ロック中、体の向きが線路に沿う。停車中に向きが反転しない。
6. コンソールに1フィックス1行で `生lat/lon`・`スナップ後lat/lon`・`railLockOk`・`最寄り線路までの距離` が出る。
7. GPS追従を使わない既存モード（explore / 経路シム / BIRD）の挙動が一切変わっていない。

## 6. 実装後にやること

- 変更ファイルと、上記完了条件のどこまでを静的に確認したかを報告する。
- デプロイコマンドを提示する（`git add -A; git commit -m "..."; git push`。Renderがmainへのpushで自動デプロイする）。PowerShell 5.x のため `&&` は使わず `;` 区切りで書くこと。
- 実機確認はユーザーが電車に乗ったときに行う。**「実機確認済み」と書かないこと。**
