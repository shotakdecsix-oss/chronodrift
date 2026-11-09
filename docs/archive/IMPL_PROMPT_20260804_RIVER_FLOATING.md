# 実装指示: 川の水面が地面から約5m浮く — 実測で確定した原因と修正

作成: 2026-08-04 / PC Chrome DevTools の実測で確定(`CONSULT_river_water_floating.md` の仮説bが的中)

---

## 0. 実測結果(結論)

ニューヨーク/ジャージーシティ、ハドソン川岸で計測:

| 種別 | areaKind | bins | 水面Y | 水面実標高 | 内包 |
|---|---|---|---|---|---|
| **川(地形追従)** | water | **50** | **17.96** | **4.98m** | true |
| 海(固定Y) | sea | 1 | 9.30 | 0.65m | true |

```
足元Y 8.85 / 足元実標高 0.42m   elevBase -4   seaLevelY 8   seaYOffset 1.3
```

- **浮いているのは川(`natural=water` → `buildAreaPoly` → `_computeWaterProfile`)。**
- 水面 4.98m に対し地面 0.42m → **4.56m 浮き**。報告の「5m」と一致。
- **海(coastline / 固定Y)は 0.65m で設計どおり。`seaYOffset()` は無罪。**
  → 相談ドキュメントの仮説a・cは棄却。仮説bが正しい。

該当ポリゴンのプロファイル(ログ):

```
[water] profile bins=50 min=16.5 max=91.5 near=yes
```

ゲーム単位→実標高は `y / ELEV_SCALE + elevBase` = `y/2 - 4` なので
**実標高 4.25m 〜 41.75m**。1枚の水面ポリゴンの中で水位が37m変化している。
そして**最低ビンですら 4.25m** で、足元(0.42m)より 3.8m 高い。

---

## 1. 原因

`part4.js` `_computeWaterProfile` のノード収集(483行目付近):

```js
const NODE_MARGIN = FAR_STEP * 0.5; // 100m
...
if (!pointInPolygon(nx, nz, pts) && !_nearPolygonBoundary(nx, nz, pts, NODE_MARGIN)) continue;
nodes.push(i, j, b);   // ★ 内側ノードと「外側100mの岸ノード」を区別せず同じビンへ
```

集約は `_binPercentileMax`(ノード3個以上なら **90%点**)。

**広い都市河川では、この90%点がちょうど「岸壁・埠頭の高さ」に当たる。**

- ハドソン川の川面上の地形ノードは、`landFloorM`(実標高0.5m)まで底上げされた値
  → 内側ノードだけなら水位は 0.8m 程度になるはず
- 一方、外側100mの岸ノードは都市の岸壁・street level で実標高 4〜10m
- 川幅1.5km を 200m 格子で切ると、1ビンあたり内側7〜8点 + 両岸の margin 数点
  → **90%点はほぼ確実に岸ノードを選ぶ**

`NODE_MARGIN` は本来 **「細い川で内側にノードが1つも入らない」ときの救済**として入れたもの。
**広い川では救済が不要なのに常時混ざる**のが誤り。

### なぜ相模川では出なかったか

相模川は川幅に対して両岸が低く平坦(実測でも地面 -6.19 に対し水位 -5.3 = 差0.45程度)。
岸ノードを拾っても数値がほとんど変わらなかった。**NYで初めて条件が揃っただけの既存バグで、
今回の海(coastline)の変更は引き金ではない。**

---

## 2. 修正

### 修正A【本体】margin ノードを「interior が無いビンだけ」のフォールバックに格下げする

ノード収集時に interior / margin を区別して保持する。判定は `pointInPolygon` の結果そのもの
(`_nearPolygonBoundary` は内側の点にも true を返すので、分類には使わない)。

```js
// part4.js ノード収集(_computeWaterProfileNodes 相当)
const inside = pointInPolygon(nx, nz, pts);
if (!inside && !_nearPolygonBoundary(nx, nz, pts, NODE_MARGIN)) continue;
if (inAnyHole(nx, nz)) continue;
nodes.push(i, j, b, inside ? 1 : 0);   // ★ 4要素目に interior フラグ(ストライドを3→4へ)
```

```js
// part4.js _computeWaterProfileFromNodes
const inner = new Array(nBins + 1), outer = new Array(nBins + 1);
for (let b = 0; b <= nBins; b++) { inner[b] = []; outer[b] = []; }
for (let k = 0; k < nodes.length; k += 4) {
  const h = farNodeYOrNull(nodes[k], nodes[k + 1]);
  if (h === null) continue;                       // 修正A-2(欠測除外)は維持
  (nodes[k + 3] ? inner : outer)[nodes[k + 2]].push(h);
}
for (let b = 0; b <= nBins; b++) {
  // ★ 内側ノードが1つでもあれば、内側だけで決める。無いビンだけ外側(岸)で救済する
  const src = inner[b].length ? inner[b] : outer[b];
  if (src.length === 0) continue;
  anyData = true;
  M[b] = _binPercentileMax(src);
}
```

**`nodes` のストライドを 3→4 に変える点に注意。** `waterNodeInfo` をキャッシュして
`rebuildAreaPolyMesh` から再利用している経路(NEAR地形到着時の再計算)も同じストライドで
読むこと。片方だけ直すと、再計算のたびにビン番号がずれて全く別の水位になる
(このプロジェクトで何度も踏んでいる「2箇所同期」の罠)。

### 修正B【併せて必須】河口で海面と同一平面になる z-fighting を防ぐ

実測地点では**海ポリゴン(0.65m)と川ポリゴンが重なっている**(表の `内包` が両方 true)。
修正Aで川の水位が 0.8m 前後まで下がると、海の 0.65m とほぼ同一平面になり、
**河口一帯でちらつく**(過去に道路交差点で経験したのと同じ現象)。

物理的に正しい規約で決める:

- **川の水面は海面より低くならない**(下流端 = 海面)。
- プロファイルの下流端ビンを `seaLevelY() + seaYOffset()` に**クランプ**し、
  そこから上流へ既存の勾配(ラチェット)で積み上げる。
- 河口付近で川と海が重なる区間は、**川側を描かない**か、
  海面より確実に上(例 +0.2 ゲーム単位)に置いて描画順を固定する。
  どちらでも良いが、**どちらかに決めて明文化すること**(曖昧なままにすると再発する)。

### 修正C【任意・次段】1ポリゴン内で水位が37m変化するのは「川ではない」サイン

`bins=50`(10km)で `min 4.25m / max 41.75m` は、1本の river reach ではなく
複数の水域(湾・貯水池・支流)が1つの multipolygon に入っていることを示す。
主軸1次元プロファイルという前提がそもそも成立していない。

当面はラチェット(`MAX_RISE_PER_BIN`)が遠方の高い値を局所へ波及させないので実害は出ないが、
将来的には **連結成分ごと(リングごと)にプロファイルを分ける**ことを検討する。

---

## 3. 検証

修正A投入後、同じプローブを同じ場所で実行し:

- `川(地形追従)` の `水面実標高m` が **0.8m前後**になること(足元 0.42m のすぐ上)
- `[water] profile bins=50 min=… max=…` の **min が 16.5 → 9〜10 程度に下がる**こと
  (実標高 4.25m → 0.5〜1m)
- 細い川(相模川・支流)で水位が下がりすぎて**地面が水面を突き破っていない**ことを目視確認
  ← margin フォールバックが効いているかの確認。ここが崩れたら修正Aの分岐が逆。

---

## 4. 大原則への追記

19. **「救済のための緩和」は、救済が必要な場合にだけ効かせる。**
    `NODE_MARGIN` は「内側にノードが無い細い川」のための例外だったが、
    無条件に適用したため、**例外が不要な広い川で本来のデータを汚染した**。
    フォールバックは必ず「本来の手段が失敗したとき」に限定して発動させる
    (`if (primary.length) use(primary) else use(fallback)` の形にする)。
