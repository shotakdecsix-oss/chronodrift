# 相談プロンプト: 川にかかる橋が水面に埋もれる不具合が、3回の修正を経てもまだ頻発する

以下をそのままFable 5に貼ってください。

---

three.js製のブラウザゲーム「ChronoDrift」(実世界の地図データをOSM/Overpass APIから取得し、リアルタイムに街を生成して歩き回れるゲーム)で、大きな川(神奈川県・相模川)にかかる橋が水面に埋もれて見える不具合を3回連続で修正しましたが、ユーザー(実プレイヤー)から「いまだに川に埋もれる橋が頻発している」と再報告され、エスカレーションすることになりました。新しい視点で根本原因を洗い出してほしいです。

## アプリの構成

- `index.html` + `js/legacy/part1.js`〜`part10.js`(元は1つの巨大なインラインスクリプトを機械的に分割したもの。グローバルスコープを共有する昔ながらの`<script>`タグの並び読み込みで、ES Modulesではない)
- OSM Overpass APIからタイル単位で道路・線路・建物・landuse・水域等を取得し、three.jsのメッシュを動的生成。道路・水域は独立に、届いた順に処理される(処理順の保証は無い)。
- 「マップデータへの忠実性を、手続き生成やパフォーマンスより常に最優先する」ことをこのプロジェクトの大原則としている。

## そもそもの発端: 水面の高さ計算を変更したら橋が水没するようになった

別件(川面に地面が混ざり込む/水面が浮く/輪郭が四角い、という一連の不具合)の根本修正として、水面ポリゴンの高さ計算(`js/legacy/part4.js`)を「輪郭頂点ごとのgetGroundY追従」から「流下方向の1次元プロファイル」方式に変更しました。

```js
// part4.js _computeWaterProfile(entry) の要旨
// 1) ポリゴンbboxの長辺方向を主軸(簡易PCA代用)とする
// 2) 主軸座標を地形格子と同じ200m(WATER_BIN=FAR_STEPと同値)でビン分割
// 3) 各ビンに掛かる地形格子ノード(farNodeY、200mグリッドの"真の自由度")のうち、
//    ポリゴン内側(または輪郭から100m以内)にあるものだけの最大値M[b]を取る
//    (bbox全体をサンプルすると川の外の陸地を拾ってしまう不具合が過去にあり、
//    ポリゴン内側限定に直した経緯がある)
// 4) 両端の生の平均を比較して高い側を「上流」とみなし、上流→下流へ単調非増加になる
//    よう累積最大を伝播(cumulative max)
// 5) 前後3ビン平均で「上向きにのみ」均す(Math.maxなので下げない)
// 6) 各ビンにマージン+0.3mを加算
function _computeWaterProfile(entry) { /* ...上記の通り... */ }
function _waterYAt(entry, x, z) { /* entry.waterProfileを参照して線形補間するだけ */ }
```

この変更で水面本体の見た目はユーザーに「おおむね改善した。OK」と確認されました。しかしその直後、「橋が水面に埋もれている」という新しい報告が来ました。

## 修正1: 橋の両端を底上げ → 「地面道路との段差」を誘発

橋の高さ(`js/legacy/part3.js` `bridgeSegmentY`)は元々、橋の入口・出口2点(`bridgeInfo.ax/az/bx/bz`。OSMの1本のway全体の始点・終点)の`getGroundY`を線形補間するだけでした。水面が地形よりかさ上げされるようになったため、この直線が水面より低くなり橋が水没するようになりました。

最初の修正: 橋の両端・中間点で水位を問い合わせ、必要ならの**両端を揃って**底上げしました。しかしこれだと橋の両端(=地面道路との接続点)の高さが、隣接する地面道路側の(底上げされていない)`getGroundY`と食い違い、**橋と地面道路の継ぎ目に段差ができる**という新しい不具合を生みました。

## 修正2: 両端を地面基準に固定し、中間だけsmoothstepで立ち上げる

段差を解消するため、設計を変更しました。

```js
// js/legacy/part3.js(現在のコード、抜粋)
const BRIDGE_CLEARANCE_ABOVE_WATER_M = 2.0;
const BRIDGE_RAMP_FRAC = 0.15; // 橋の両端から何割の区間を立ち上がりの助走に使うか

function bridgeSegmentY(bridgeInfo) {
  const trueSeaY = -elevBase * ELEV_SCALE;
  const floor = trueSeaY + BRIDGE_MIN_CLEARANCE_M * ELEV_SCALE;
  // yA0/yB0は「地面道路と接続する固定端」なので水位由来の底上げは一切加えない。
  const yA0 = Math.max(getGroundY(bridgeInfo.ax, bridgeInfo.az), floor);
  const yB0 = Math.max(getGroundY(bridgeInfo.bx, bridgeInfo.bz), floor);
  const heightAt = (f) => {
    const base = yA0 + (yB0 - yA0) * f;
    if (typeof waterSurfaceYAt !== 'function') return base;
    const x = bridgeInfo.ax + (bridgeInfo.bx - bridgeInfo.ax) * f; // 直線補間で位置を推定
    const z = bridgeInfo.az + (bridgeInfo.bz - bridgeInfo.az) * f;
    const wy = waterSurfaceYAt(x, z);
    if (wy == null) return base; // 水面が見つからなければそのまま地面基準
    const needed = wy + BRIDGE_CLEARANCE_ABOVE_WATER_M * ELEV_SCALE;
    if (needed <= base) return base;
    // f=0/1ちょうどでは底上げゼロ(地面道路と完全一致)、
    // BRIDGE_RAMP_FRAC以上離れた区間では必要な底上げを満額適用。
    const edgeT = Math.min(f, 1 - f) / BRIDGE_RAMP_FRAC;
    const ease = edgeT >= 1 ? 1 : (edgeT <= 0 ? 0 : edgeT * edgeT * (3 - 2 * edgeT)); // smoothstep
    return base + (needed - base) * ease;
  };
  return { yA: heightAt(bridgeInfo.fracA), yB: heightAt(bridgeInfo.fracB) };
}
```

`waterSurfaceYAt(x, z)`はpart4.jsに新設した、その地点にかかる水面ポリゴンの現在の水位を返す関数です(`areaPolyGrid`から`kind==='flat'`のエントリを検索し、`pointInPolygon`+hole除外の上で`_waterYAt`を呼ぶだけ)。

この修正で段差は解消されたはずですが、ユーザーから「いまだに川に埋もれる橋が頻発している」と再報告されました。

## 修正3(直近): タイル到着順序の問題と誤診断し、対症療法を追加

`bridgeSegmentY`は道路メッシュが最初に構築される瞬間に一度だけ呼ばれます。そこで「橋の道路タイルが、川の水面タイル/relationより先に処理された場合、その時点ではまだ水面ポリゴンが存在せず`waterSurfaceYAt`がnullを返す→クリアランス無しの高さで確定してしまい、後から水面が届いても誰も作り直さない」という仮説を立て、水面が確定した瞬間(`_commitWaterPoly`)にその範囲の道路を強制再構築する対策を追加しました。

```js
// js/legacy/part4.js(現在のコード、抜粋)
function _commitWaterPoly(pts, holes, minX, maxX, minZ, maxZ) {
  buildAreaPoly(pts, waterAreaMat, 0.15, holes);
  const entry = { pts, minX, maxX, minZ, maxZ };
  minimapWaterPolys.push(entry);
  polyGridAdd(minimapWaterGrid, entry);
  const margin = 60;
  if (typeof rebuildRoadsInBounds === 'function') {
    rebuildRoadsInBounds(minX - margin, maxX + margin, minZ - margin, maxZ + margin);
  }
}
```

`rebuildRoadsInBounds`(`part1.js`)はbbox内の道路レコードに`_dirty=true`を立てて`queueRoadMesh`(フレーム予算付きの再構築キュー)に積むだけの既存関数です。`rebuildRoadMesh`は`makeRoadGeo`を呼び直し、`makeRoadGeo`は`bridgeInfo`があれば毎回`bridgeSegmentY`を呼び直す設計(元からそうなっている、道路の地形追従と同じ仕組み)なので、理屈上は水面到着後に橋が自己修復するはずでした。

**しかしこの修正の後もユーザーは「頻発している」と報告しています。** タイル到着順序だけが原因ではない、もっと構造的な見落としがあると考えています。

## 気づいている、まだ検証・対策していない疑わしい点

### 疑い1: 橋が複数のOSM way断片に分割されている場合、smoothstepの「両端固定」が内部の継ぎ目で誤動作する

`bridgeInfo`は**1本のOSM way単位**で作られます(`part8.js`)。

```js
// part8.js(抜粋)
const isBridge = type !== 'motorway' && tags.bridge && tags.bridge !== 'no';
// ...
if (isBridge) {
  const pts = el.geometry.map(g => latLonToXZ(g.lat, g.lon));
  // ...
  bridgeAx = pts[0].x; bridgeAz = pts[0].z;       // このwayの最初のノード
  bridgeBx = pts[pts.length-1].x; bridgeBz = pts[pts.length-1].z; // このwayの最後のノード
}
for (let i = 0; i < el.geometry.length-1; i++) {
  // ...
  bridgeY = { ax: bridgeAx, az: bridgeAz, bx: bridgeBx, bz: bridgeBz,
              fracA: bridgeCum[i]/bridgeTotalLen, fracB: bridgeCum[i+1]/bridgeTotalLen };
  addRoad(a.x, a.z, b.x, b.z, width, type, bridgeY, el.id);
}
```

OSMでは長い橋が編集履歴・車線数変更・行政界等の理由で**複数の別々のwayオブジェクトに分割されてタグ付けされていることが珍しくありません**。もしそうなっていた場合、橋の物理的な1本の構造物が、コード上は独立した複数の`bridgeInfo`(それぞれ別々のax/az/bx/bz、fracAは常にそのwayの中で0スタート)として扱われます。

このとき、修正2の「f=0/1ちょうどでは底上げゼロ=地面道路と完全一致」というロジックは、**そのway断片の始点・終点が実際には地面ではなくまだ川の上(=隣のway断片との継ぎ目)であっても、無条件にクリアランスをゼロに戻してしまいます**。結果として、橋を構成する複数のway断片の**継ぎ目部分だけ**水面近くまで沈む可能性があります。これは「橋によって埋もれる/埋もれない」「同じ橋でも一部区間だけ埋もれる」という報告と整合する、有力な未検証の仮説です。

### 疑い2: motorway(高架の高速道路)は完全に別の高さ計算経路で、水位を一切見ていない

```js
// part8.js: motorwayはbridge=yesが付いていてもisBridge判定から除外される
const isBridge = type !== 'motorway' && tags.bridge && tags.bridge !== 'no';

// part3.js addMotorway: 常時、その場のgetGroundYに固定オフセットMWY_Hを足すだけ
const MWY_H = 7, MWY_W = 16; // ゲーム単位(ELEV_SCALE=2.0なので実質+3.5m相当)
const y1 = getGroundY(x1, z1) + MWY_H, y2 = getGroundY(x2, z2) + MWY_H;
```

`motorwaySlopes`/`addMotorway`/`rebuildMotorwayMesh`は`bridgeSegmentY`や`waterSurfaceYAt`を一切呼びません。相模川を渡る高速道路・自動車専用道路がある場合、その区間は今回の一連の修正の影響を全く受けておらず、固定+3.5m相当のオフセットだけで、水面が大きくかさ上げされた場合には埋もれる可能性が構造的に残っています。

### 疑い3: 橋の位置サンプリングがバンク間の直線補間のため、実際の橋の経路(カーブ)とズレる

`heightAt(f)`内の`x = bridgeInfo.ax + (bridgeInfo.bx - bridgeInfo.ax) * f`は、橋のOSM形状(複数ノードでカーブしている場合がある)を無視して、**入口・出口2点を結ぶ直線上**の位置として`waterSurfaceYAt`に問い合わせています。実際の橋(や川)が直線から外れていると、サンプリング座標が水面ポリゴンの外に出てしまい、`waterSurfaceYAt`がnullを返して「本当は水面の真上なのにクリアランスが適用されない」区間が生じる可能性があります。

### 疑い4: 水面ポリゴンが予算切れで`pendingAreaWaterPolys`に溜まったまま永遠にコミットされないケース

水面ポリゴンには`areaPolyBudget.water`という上限があり、切れた場合は`pendingAreaWaterPolys`に退避されて90フレームごとに再試行されます。もし相模川の当該区間の水面ポリゴンがずっと予算切れのままだった場合、`_commitWaterPoly`(=橋の強制再構築のトリガー)が一度も呼ばれず、修正3の対策も発動しません。この場合`waterSurfaceYAt`は恒久的にnullを返し続け、橋は「地面基準のまま」フォールバックしますが、その「地面」自体(`getGroundY`)は水面が存在しない前提の値なので、水面ポリゴン側が(コミットされていなくても)ミニマップや回避判定には既に登録されている可能性があり、視覚的な水面(リボンフォールバック等)と地面基準の橋がズレて見えるかもしれません。

## 知りたいこと

1. 上記の疑い1〜4のうち、どれが最も有力だと考えますか。複数が同時に発生している可能性も含めて評価してほしいです。
2. 疑い1(OSM wayの分割による継ぎ目での誤動作)が正しい場合、根本的にはどう直すべきでしょうか。同じ物理的な橋を構成する複数のway断片を検出して1つの`bridgeInfo`にグルーピングし直す(例: 端点の座標が十分近い断片を`bridge`タグの有無に関わらず連結する)方向が妥当でしょうか。それとも「橋の両端で無条件にクリアランスをゼロにする」という前提自体をやめ、**橋の各点で毎回`waterSurfaceYAt`を問い合わせて存在すればクリアランスを適用し、地面道路との接続点付近だけ別途判定する**(例えば「その点に隣接する非橋の道路レコードが存在するかどうか」を見る)方式に変えるべきでしょうか。
3. 疑い2(motorwayが未対応)が該当する場合、`addMotorway`/`motorwaySlopes`にも`waterSurfaceYAt`を組み込むべきでしょうか。橋脚を描画しない「常時空中に浮く」設計(コード内コメントに明記)のため、固定オフセット`MWY_H`をやめて可変クリアランスにする場合、地形の起伏に対する見た目の一貫性(急に高さが変わって見えないか)に注意点はありますか。
4. そもそも「橋の高さを、入口・出口2点の直線補間+水位に応じた局所的な底上げ」という設計自体が、実際のOSMデータ(分割・カーブ・部分的にしか水面と重ならない橋等)に対して脆弱すぎるのではないかと懸念しています。もっと堅牢な設計思想(例: 橋の全長にわたって「その真下に水面ポリゴンが存在するか」を密にサンプリングしてプロファイル化し、地面道路との接続点付近だけを検出して強制的にゼロへ収束させる、等)があれば教えてください。
5. 診断を先に進めるための、実機なしでもできる切り分け方法(コンソールログの仕込み方等)があれば教えてください。特に「相模川にかかる橋のうち、OSM上で何本のway断片に分割されているか」「motorwayタグが付いているか」を実際に確認する調査方法があれば知りたいです。

Macが無く実機のライブデバッグができないため、コードレビュー・設計レビューベースでの助言が中心になります。よろしくお願いします。
