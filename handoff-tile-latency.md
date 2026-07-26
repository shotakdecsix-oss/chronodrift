# 引き継ぎ: タイル取得レイテンシ改善(chronodrift / isehara-game)

以下は前のチャットからの引き継ぎ内容です。この続きから対応してください。

---

## 目的(ここが本題。ずっと変わっていない)

ブラウザ3Dマップゲーム `chronodrift.onrender.com` で、**プレイヤーの足元と周囲のタイルの道路・建物が出るまでが遅い**。デバッグオーバーレイの色遷移で言うと:

- **R = 緑赤灰 → 緑緑赤** … キュー投入 → 道路確定(道路クエリの往復)
- **B = 緑緑赤 → 緑緑黄** … 道路確定 → 建物確定(建物クエリの往復)

**tier1(現在地)とtier2(3x3の外周8枚)の両方**で、RもBも時間がかかりすぎる、というのが元の依頼。

なお現在は本題から一歩離れて、**「計測とデータ経路が信用できる状態か」**の確認に時間を使っている。理由は正当(信用できない数字で改善判断をすると誤った方向へ進むため)だが、本題はあくまで上記であることを見失わないこと。

## 環境・進め方の制約(再確認不要)

- 会話は日本語。トークン消費は最小限に。手動でできることは依頼する
- WindowsのPowerShellが5.x以前。コマンドは `&&` ではなく `;` 区切り
- **push コマンドには必ず `Remove-Item -ErrorAction SilentlyContinue ...\.git\index.lock;` を前置する。** 過去に残留ロックで push が黙って失敗し(`Everything up-to-date`)、原因究明に時間を溶かした
- Render は無料プラン。15分でスピンダウン、コールドスタート約39秒、ディスクは揮発。main への push で自動デプロイ
- ユーザーは**別のレビュアーAIの指摘を毎回持ち込む**。これまで4回、こちらの誤りを正確に捕捉されている。断定する前にコードで裏を取ること

## 構成のポイント(誤解しやすい所)

`server/server.js` は serve 時に `index.html` へ `<script>` を注入(INJECT)し、`window.fetch` を monkey-patch して `https://overpass-api.de/api/interpreter` を `/api/overpass` に書き換えている。**クライアントソースを grep してもプロキシ経路は出てこない**(過去にこれで「プロキシは死にコード」と誤診断した)。

INJECT はテンプレートリテラルなので、`\/` は出力時に `/` に潰れる。正規表現リテラルを書くと壊れる(実際に `/text\/html/i` が `/text/html/i` になって INJECT 全体が SyntaxError で死に、全リクエストが直接モードに落ちた事故あり)。**検証は必ず「評価後の出力形」に対して行うこと。**

## 計測ツール

`DEBUG_PROBE_TILE_LATENCY.js` をコンソールに丸ごと貼り付け → 密集地へジャンプして2〜3分歩く → `TP.report()`。

## 確定している事実

- **上流Overpassは1IPあたり2スロット固定**(`/api/status` で `rate limit=2 / available now=0` を複数回実測)。クライアント側の同時実行を増やしても429が増えるだけ
- 現在 `OSM_TILE_CONCURRENCY = 2`、`OSM_TILE_BATCH = 3`、`OSM_TILE_M = 1600`
- ソロクエリ1本の往復は速い: **R tier1 ≈ 8.6s / B tier1 ≈ 7.8s**(直接モード時、n小)
- **R tier2 ≈ 108s**(n=2)。1本8.6秒なのに108秒 → **大半がキュー待ち**
- 稼働枠は上限2に **76〜95% 張り付き**、平均キュー長 **79〜88**
- キューの内訳例: `road:4, building:3, combined:94` / tier別 `1:0, 2:5, 3:15, 4:81`

## 未 push の変更(3ファイル。まずこれを反映する)

1. `js/legacy/part8.js` — tier2の道路/建物ジョブを3枚まとめにする実験(Step C)を入れて、**revert 済み**。現在はソロ固定に戻っている。判断の経緯を長いコメントで残してある
2. `server/server.js` — `CONN_FAIL_CODES` から `ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE` を除去し、`MIDSTREAM_FAIL_CODES` として分離(後述の争点)
3. `DEBUG_PROBE_TILE_LATENCY.js` — DIRECT の赤字警告を元の意味に戻した。占有率の判定文言も訂正

```
Remove-Item -ErrorAction SilentlyContinue C:\Users\Shoichi\Desktop\isehara-game\.git\index.lock; cd C:\Users\Shoichi\Desktop\isehara-game; git add -A; git commit -m "stop counting mid-stream failures as unreachable, revert tier2 batching, restore probe warning"; git push origin main
```

## 現在オープンな最大の争点

**「Renderのegressがoverpass-api.deに対して6〜7割失敗する」という結論が、誤判定だった可能性が高い。**

`isUnreachableError` からタイムアウト判定を外したと報告していたが、その1段下の `CONN_FAIL_CODES` 正規表現に `ETIMEDOUT|ECONNRESET|EPIPE|ECONNABORTED` が残っており、**同じ誤分類が生き続けていた**(同じ形の誤りが通算4回目)。これらは「経路が死んでいる」ではなく「接続が途中で切れた」で、重いクエリでは日常的に起きる。

反証として、`/api/upstream-status`(同じ `httpsRequestOnce` を使う軽いGET)は Render の egress から overpass-api.de へ **200 を返し、2スロット空きまで読めていた**。経路が遮断されているなら軽いGETも通らないはず。

この誤判定を根拠に **`server/server.js` の355行目で Overpass の既定を直接アクセスに変更済み(push 済み)**。争点が解決したら、この判断も撤回対象になる。

```js
if (prefix === OVERPASS_PREFIX && !window.__FORCE_PROXY_OVERPASS__) return direct();
```

## 次にやること(この順序で)

1. 上記3ファイルを push
2. コンソールに `window.__FORCE_PROXY_OVERPASS__ = true;` を貼る(fetch ごとの判定なのでリロード不要)。続けてプローブを貼って密集地を2〜3分歩く
3. **502の比率**を見る。以前の 76% から落ちれば「egress が死んでいる」説は消える
4. 経路の信頼性が片付いたら、**本題(R/Bの短縮)に戻る**

## 本題に戻ったときの選択肢(まだどれも未確定)

作業仮説: **上流の総実行時間 ≒ タイル枚数 × 条件節数**。本数をどう束ねても総量は動かない。ただし**この仮説はまだ実証されていない**(下の「駄目だったこと」参照)。

- **案A: `PERF.prefetchR` を 2→1(5x5→3x3)** … 枚数を減らす。ただし `ROAD_UNLOAD_DIST=2500m` / `BUILDING_GEN_DIST_REAL=3000m` より狭くなるので生成距離とセットで下げる必要がある。**効果は未確定**
- **案B: 条件節を減らす** … 道路クエリは11条件節あり、うち5つが正規表現マッチ(`landuse` は10値の alternation)。削る候補は `amenity`(学校/病院の回避ゾーン専用)、`leisure`、`landuse` の値を絞る。見た目の距離は変わらないが、削ったタグに依存する生成ロジックの副作用に注意
- **案C: 道路クエリを highway+railway 先出しの2段に分割** … 総時間はむしろ増えるが「道路が見えるまで」だけは短くなる。リスク: 水域が確定する前に建物・木が置かれ、過去に何度も直した「水上の木/建物」が再発しうる

### 判断の前に必要な計器(これが無いと案Aを決められない)

**リクエスト1本ごとの tier と完了時間**をプローブに記録させる必要がある。

現状の `平均far` カウンタでは判別できない。`batchSize` は combined でも `!roadReadyTiles.has(ptKey) || nextFailCount >= 2 || nearSolo` のいずれかで1になり、ソロなら `tilePriority='near'` になるため、tier3のジョブが走っていても far カウンタは 0 のまま。実際、スナップショットの `実行中: ['1,2|road(26.9s)', '2,2(4.4s)']` の `2,2` は combined ジョブ = tier3以遠が2枠の1つを使っている証拠(tier1+2 は必ず road/building の分離kindで積まれるため)。

また `_activeFetchStarts` の値は**実行中の経過秒であって完了時間ではない**。過去にこれを完了中央値と比較して誤った結論を出した。

## 別件で気になっていること(未調査)

進行方向の先読みが `k=3..6`(最大6タイル先=9600m)まで積んでおり、tier4 に81件溜まっている。処理能力を大きく超えていて実行されない可能性が高い。これらは `queuedTiles` に登録済みなので、**「永久に実行されないのに取得済み扱いでマークされたタイル」**が生まれ、プレイヤーがそこへ歩いて行った時に再投入されず白紙のままになる恐れがある。レイテンシとは別のバグとして要調査。

## 試して駄目だったこと(繰り返さない)

- **「プロキシは死にコード」誤診断** … クライアントを grep してヒットしなかったため。実際は INJECT の monkey-patch で書き換えている
- **`maxAttempts` 2→4** … 成功率が 38%→24% に**悪化**。接続失敗は独立事象ではなく時間相関がある。2に戻した
- **タイムアウトを到達不能判定に使う** … 「一度も成功していないホストのタイムアウト」→「3連続タイムアウト」と2段階で試し、どちらも密集地の起動直後に誤爆。判定そのものを撤去した(が、正規表現側に残っていたのが今回の争点)
- **`overpass.private.coffee` をメインにする** … 実測で失敗。`overpass-api.de` に戻した
- **tier2の道路/建物ジョブを3枚まとめにする(Step C)** … 悪化に見えたので revert したが、**「悪化した」もまだ確定ではない**。前回計測が PROXY(502が76%)、今回が DIRECT で、経路が丸ごと違うため A/B が成立していない
- **プローブの警告を「DIRECTが正常」に反転** … 誤判定に基づいて縮退経路を正規化する変更だったため撤回済み

## まだ書いてはいけないこと

`GENERATION_PIPELINE.md` 等への「Overpassの実行時間は bbox 数に比例することが実証された」の追記は**保留**。根拠にした 26.9s は n=1 かつ実行中の途中経過(下限値)でしかない。
