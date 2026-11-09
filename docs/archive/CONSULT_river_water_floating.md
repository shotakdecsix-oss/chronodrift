# 相談プロンプト: 川の水面が地面から約5m浮いて見える

このファイルは、isehara-game(three.js製・OSM/Overpassデータ駆動の3D街歩きゲーム)で
発生した未解決バグを、別セッション/別AIに相談するための自己完結ドキュメントです。
このファイルだけを読んで状況を理解し、診断・修正案を出せるように書いています。

## 症状

ユーザー報告:「川の水面が標高5mくらいになって浮いている」
- 場所: 未確定(直前の会話はニューヨーク/ジャージーシティ、ハドソン川周辺を探索中だったが、
  ユーザーは正確な座標をまだ提示していない)
- 見た目: 水面メッシュが地形より明らかに高い位置に浮いて見える(地形との間に隙間が見える)
- 発生タイミング: 直前に「海(coastline)の固定海面が地形の下に隠れる」バグを修正し
  デプロイした直後の報告。関連が疑われるが未確認。

## プロジェクト構成(必要な部分のみ)

- プレーンJS。`js/legacy/part1.js`〜`part10.js`が`<script>`タグで順に読み込まれ、
  1つのグローバルスコープを共有する(ESモジュールではない)。後で読み込まれるファイルの
  関数を、先に読み込まれるファイルの「関数の中」から参照するのは安全(実行時には全部
  読み込み終わっている)。
- 座標系: `x = (lon-MID_LON)*SCALE*COS_LAT`(x=東)、`z = -((lat-MID_LAT)*SCALE)`(z=南)。

## 水面には2系統ある(重要)

1. **川・池**(`natural=water` / `waterway=riverbank`、part4.js `handleAreaFeature`経由)
   → `buildAreaPoly(pts, mat, yOff, holes)`(part4.js 814行目)。
   頂点ごとに`getGroundY(x,z) + yOff`で地形に追従する高さを取る
   (`_computeWaterProfile`でOSM実測標高から1次元縦断プロファイルを作り、
   `_instantiateAreaPolyMesh`内の格子生成で使う)。**地形が変わればそれに追従するので、
   通常は「地面から浮く」は起きにくい設計。**

2. **海**(`natural=coastline`、2026-08-04に新規実装、part4.js `processCoastlineFill`)
   → `buildFixedFlatAreaPoly(pts, mat, yOff, fixedY, holes)`(part4.js 853行目)。
   地形を一切サンプリングせず、**固定の絶対Y**(`seaLevelY() + seaYOffset()`)を使う。
   ユーザー方針(2026-08-04)で「海は地図に忠実な固定高さにする」と決めた経緯がある
   (詳細はメモリ`project_isehara_game_sea_coastline.md`参照)。

高さ計算の基礎:
- `seaLevelY()` = `-elevBase * ELEV_SCALE`(part4.js 846行目。実標高0m相当)
- `ELEV_SCALE = 2.0`(part5.js 109行目。実標高1m = ゲーム単位2.0)
- `elevBase`: リージョンごとの最低観測標高。`establishRegionBase`(part6.js)で地域切替時に確定
- `landFloorM = seaLevelM(0) + LAND_FLOOR_MARGIN_M(0.5)`(part6.js 68,167,299行目)
- 地形側(`loadWideTerrain`/`loadNearTerrain`, part6.js)は、標高サンプルが`null`でない限り
  必ず`Math.max(m, landFloorM)`まで底上げする(江東区0m地帯対策、既存ロジック)
- 標高が完全に`null`(欠測)の場合のみ`oceanFloor = (0-elevBase)*ELEV_SCALE - 10`

## 直前にこのセッションで行った変更(疑わしい順)

1. **`seaYOffset()`新設**(part4.js、`seaLevelY()`の直後)。
   従来、海面ポリゴンのYオフセットは固定値`0.15`だったが、これを
   `LAND_FLOOR_MARGIN_M * ELEV_SCALE + 0.3`(= 0.5*2.0+0.3 = **1.3ゲーム単位** ≒
   実測0.65m相当)に引き上げた。
   理由: 「地形側がlandFloorMまで底上げされると、固定0.15の海面より地形の方が高くなり、
   海面が地形の下に隠れて見えなくなる」というユーザー報告(「水面が地面の下に入っている」)
   への対処。`processCoastlineFill`内の2箇所の`buildFixedFlatAreaPoly`呼び出し
   (Phase1のribbon、Phase2のタイル全塗り)両方でこの新しいオフセットを使うようにした。
   **これは「海(coastline)」のfixed-Y処理にのみ影響し、「川」の`buildAreaPoly`
   (地形追従)には手を入れていない。** ただし河口付近では`natural=coastline`と
   `natural=water`の境界があいまいで、ユーザーが「川」と呼んでいる水面が実際には
   このセッションで実装した海(coastline)処理で塗られている可能性がある
   (この切り分けが最優先で必要)。
   ただし引き上げ幅は0.65m相当であり、「5m浮いている」という報告とは数値が一致しない点に
   注意(下記「仮説」参照)。

2. **`processCoastlineFill`のPhase2高速化**。5サンプル点の最近傍coastline区間探索を、
   毎回nearWays全wayの全点を舐める実装から、タイル近辺の区間だけを1回だけ抽出して
   使い回す実装に変更。**判定結果(seaVotes)を変えない意図の最適化で、高さの計算式には
   一切触れていない。** 高さ関連の原因である可能性は低いが念のため記載。

3. それ以前(v1〜v9)の海(coastline)関連の一連の変更。経緯・過去のバグと修正は
   メモリファイル`project_isehara_game_sea_coastline.md`に時系列で記録済み
   (natural=coastline未クエリ→江の島沈没→海岸線形状の非忠実→NY川面非表示→
   広い水面の塗り残り→Phase2排他バグ→Phase2一点判定の脆弱性→地形の下に隠れる、
   の順で対処してきた)。

## 仮説

a. **ユーザーが見ているのは実は「川」ではなく「海」ポリゴン。** 河口付近で
   `natural=coastline`のribbon/Phase2塗りが、地形追従ではない固定Yで塗られている
   ため浮いて見える。この場合(1)の`seaYOffset()`引き上げが直接の引き金だが、
   引き上げ幅0.65m相当と「5m」という報告が数値的に一致しない。単位換算ミス
   (ゲーム単位と実メートルの取り違え、`ELEV_SCALE`の掛け忘れ/二重掛け等)がないか
   `seaYOffset()`と`seaLevelY()`の呼び出し箇所を再確認する必要がある。

b. **本当に`buildAreaPoly`系の「川」ポリゴンで、今回の変更とは無関係の既存不具合が
   別トリガーで再発した。** 過去に「橋の水没」(水面が沈む方向)が繰り返し報告された
   経緯がある(メモリ`project_isehara_game_water_poly_budget_retry.md`)。今回は逆方向
   (浮く方向)だが、`_computeWaterProfile`のプロファイル計算(1次元縦断・複数ビン)が
   何らかの理由で異常に高いビン値を採用してしまっている可能性(欠測点の扱い、
   `_dirty`関連の握りつぶし等、過去に指摘された類似パターン)。

c. **`elevBase`自体がこの地域で誤って確定している。** 標高データの部分欠測により
   リージョン基準がずれ、地形・水面どちらも(場合によっては片方だけ)相対的にズレて
   見えている可能性。過去に「標高欠測(GSI404)が0に潰れ水位計算を汚染」という
   類似の実例がある(相模川橋梁のケース、メモリ`project_isehara_game_water_poly_budget_retry.md`)。

## 未確認・最初に集めるべき情報

- 正確な場所(標高パネルの緯度経度、標高表示の数値)とスクリーンショット
- ブラウザ開発者コンソールのログ。特に`[water] profile ...`行(bins/min/max)と
  `[coastline] tile ...`行(該当タイルでbuiltされたか)
- 該当ポリゴンが「川(natural=water/waterway=riverbank、buildAreaPoly)」なのか
  「海(natural=coastline、buildFixedFlatAreaPoly)」なのかの切り分け
  (デバッグ用に、両ポリゴンのentryに`areaKind`などの種別が入っているはずなので、
  一時的にログ出力を追加して確認するのが早い)

## 関連ファイル・行番号(2026-08-04時点)

- `js/legacy/part4.js`:
  - `buildAreaPoly`: 814行目(川・池、地形追従)
  - `_computeWaterProfile`: buildAreaPoly内で呼ばれる高さプロファイル計算
  - `seaLevelY()` / `seaYOffset()`: 846〜859行目付近
  - `buildFixedFlatAreaPoly`: 853行目(海、固定Y)
  - `processCoastlineFill`: 993行目〜(Phase1 ribbon、Phase2タイル全塗り)
- `js/legacy/part6.js`:
  - `LAND_FLOOR_MARGIN_M`: 68行目
  - `landFloorM`適用(地形の底上げ): 162〜170行目、293〜302行目
  - `elevBase`確定: `establishRegionBase`
- `js/legacy/part5.js`:
  - `ELEV_SCALE`: 109行目

## 参考メモリ(要約が必要ならこのファイル名で検索)

- `project_isehara_game_sea_coastline.md`(海面実装の全経緯 v1〜v9+perf修正)
- `project_isehara_game_water_poly_budget_retry.md`(川・橋の水没バグの過去の経緯)
- `feedback_never_collapse_missing_data_to_zero.md`(欠測データを0に潰さない、という
  このプロジェクト共通の教訓)
- `project_isehara_game_map_fidelity_first_principle.md`(実データ優先の大原則)
