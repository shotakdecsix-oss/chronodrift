# 実装プロンプト: dormant復帰の容量ベース予算化 + 距離優先選択

前提: 別チャットで検証済み。実機ログの結論は2つ:
(1) pendingTotal≈0・generated≈復帰レート200/2s → パイプライン全体がREVIVE_BUDGETで律速。
(2) タイル22,-21のbuildPendingが7356のまま6回連続不変 → レートだけでなく**選択のLIFO飢餓**。
reactivateは配列末尾から走査して予算で打ち切るため、毎サイクル見るのは「最近dormant入り
した建物」だけ。古い近傍dormantには走査が永遠に届かない。レートを上げるだけでは直らない。

対象: `js/legacy/part1.js`(reactivateNearbyDormantBuildings、unloadFarBuildings、
dormantBuildingsへのpush箇所全部)、`js/legacy/part9.js`(dormant push箇所、オーバーレイ)。

## 1. dormantBuildingsを空間グリッド化(選択の修正・本命)

- `dormantGrid = new Map()` を追加。セルはBUILDING_CELLより粗い200m
  (`DORMANT_CELL = 200`)。キー `gx+','+gz`、値は建物記述子の配列。
- dormantへのpush箇所(unloadFarBuildings、part9.jsの生成距離外/bMax到達時、
  今後の隔離キュー移送)を共通ヘルパ `dormantAdd(b)` に集約し、配列とグリッドの
  両方へ登録する(配列は総数管理・全走査用に残してよい)。
- `reactivateNearbyDormantBuildings` の走査を「配列末尾から」→
  「**プレイヤーのセルから近いセル順のリング歩き**」に変更:
```js
// 予算が尽きるかリング半径が復帰距離(_realRevLim)を超えるまで、
// リング0(自セル)→リング1→...の順にセルを見る。セル内は全件復帰対象チェック。
// 復帰した建物はセル配列からsplice + dormantBuildings本体からも除去
// (本体配列の除去がO(n)になるなら、記述子に_deadフラグを立てて
//  遅延コンパクション(次の全走査時にfilter)でよい)。
```
- 高層の距離換算(h>40mは÷1.6)は現行実装のまま維持。

## 2. REVIVE_BUDGETを容量ベースに(レートの修正)

- 「80%閾値で200/Infinity切替」を廃止し、常に:
```js
const REVIVE_BUDGET = Math.min(600, Math.max(0, (PERF.bMax * 0.95 | 0) - buildingRecords.length));
```
- 冒頭の `if (buildingRecords.length >= PERF.bMax) return;` は
  `if (REVIVE_BUDGET <= 0) return;` に置き換え(意味は同じで一貫する)。
- 根拠: 修正6のevictionが85%まで空けるので空き容量≈1800が自然な予算。
  「空いた分だけ入れる」ため雪崩スパイクは構造的に発生しない(固定200の存在理由が消える)。
  実メッシュ生成コストは下流のフレーム予算(8ms deadline)が既に守っている。
- レジーム切替(過渡/定常の二分法)は撤廃。密集地ではbMax近傍が定常なので成立しない。

## 3. オーバーレイ表示の分離(1行・無条件でやる)

- console.table/平面色の集計で buildPending を「pending」と「dormant」の2列に分ける。
- 理由: 東京駅は既知9万件vs表示上限12000で、遠方タイルのdormantが高止まりするのは
  **構造的に正常**。合算表示だと正常を詰まりと誤読して調査コストを浪費する。

## 4. やらないこと

- bMaxの動的引き上げは**却下**(東京駅はGPUクラッシュが起きた当の場所。密集地だけ
  キャップを緩めるのは危険な場所でだけ外す設計)。
- 進行方向優先の専用機構は不要(近いセル順+pending側の近い順ソートで前方が自然に優先される)。

## 実装順・検証

- 本修正を**単独デプロイ**(隔離キュー(b)は次のデプロイ。同時に入れると効果の切り分け不能)。
- 検証: (1) 東京駅で generated/2s が復帰レート律速(≈200)から数百〜千台に上がること。
  (2) 近傍タイルのpending(分離表示後の値)が数サイクルで減ること。
  (3) 22,-21のような「凍結タイル」が解消すること。遠方タイルのdormantが高いままなのは正常。
- 計測ログ([buildgen]行)に `revived/2s` を追加すると律速の切り分けが今後も容易になる。
