# 実装指示 ③:近くの「名前のある場所」を表示する(A-1)

## 着手前に必ず

```
grep -rn "addressDisplay\|updateAddressDisplay\|checkAddressDisplay" js/legacy/part7.js
grep -rn "globalStationPoints" js/legacy/*.js
grep -rn "LANDMARK_TOWER_NAMES\|tags.name\|\.name\b" js/legacy/part2.js | head -30
grep -rn "polyGridAdd\|queryPolyGrid\|landuseGrid" js/legacy/part1.js
```

## 前提(調査済みの事実)

1. **住所表示は既に実装済み**。`js/legacy/part7.js:19-59`。Nominatim 逆ジオコーディングで `📍 伊勢原市石田` のように出す。更新は「600フレームごと **かつ** 前回位置から150m以上移動」。BAN回避のため意図的に絞られている。**この頻度制限を緩めてはいけない。**
2. **Overpass のクエリに `place` / `historic` / `tourism` は含まれていない。** 現在取得しているのは以下のみ:
   ```
   way["highway"] / way["building"] / relation["building"]
   way["railway"="rail"] / node["railway"="station"] / node["railway"="halt"]
   node["public_transport"="station"]
   way["waterway"~"river|stream|canal|riverbank"] / relation["waterway"="riverbank"]
   way["natural"~"water|wood"] / way["natural"="coastline"] / relation["natural"="water"]
   way["leisure"~"park|garden|playground"]
   way["landuse"~"residential|commercial|industrial|retail|mixed_use|farmland|orchard|meadow|allotments|forest"]
   way["amenity"~"school|university|college|hospital"]
   ```
3. **駅ノードは既に取得・蓄積されている**:`globalStationPoints`(`railway=station/halt`、`part1.js`/`part2.js`)。
4. **建物の `name` タグはレスポンスに既に入っているが捨てている。** 現在 `name` を使っているのは `LANDMARK_TOWER_NAMES`(`part2.js:1091`)の完全一致検出だけ(東京タワー等4施設)。
5. 空間ハッシュの汎用機構が既にある:`polyGridAdd` / `queryPolyGrid`(`part1.js:938〜`)。`landuseGrid` がこれを使っている。
6. **3D空間内にテキストを出す仕組みは存在しない**(`THREE.Sprite` の使用箇所ゼロ)。

## 目的

住所しか出ない世界に**固有名詞を入れる**。目の前の建物や施設が何なのか分かるようにする。

**Phase 1 と 2 は通信を一切増やさない。** ここが最大の利点。

---

## Phase 1:駅名を出す(まずこれだけを1回で)

- `globalStationPoints` に `name` タグが乗っているかをまず確認する。乗っていなければ、駅ノードのパース箇所で `tags.name` を保持するように直す(これも通信ゼロ)。
- プレイヤーから**半径300m以内**に駅があれば、`#addressDisplay` の下に1行足す:
  ```
  🚉 伊勢原駅 120m
  ```
- 複数あれば最も近い1つだけ。無ければ行ごと非表示。
- 更新は毎フレームではなく、**住所表示と同じチェック周期に相乗り**するか、または30フレームに1回程度。

## Phase 2:name付きの実建物を拾う(本命)

- 建物メッシュ生成時、`tags.name` があれば軽量なレコードを登録する:
  ```
  { x, z, name, kind }   // kind は building/amenity/leisure のタグから決める
  ```
- 保持は**空間ハッシュ**(`polyGridAdd` / `queryPolyGrid` を流用)。全件走査は絶対にしないこと。
- タイルが破棄されるときは、このレコードも一緒に破棄する。**`landusePolygons` が `part4.js:1090` 付近でタイル単位に削除されているので、同じ場所・同じやり方で消すこと**(消し忘れると存在しない建物の名前が出続ける)。
- プレイヤーから**半径50m以内**の最も近いものを、駅名の行と同じ場所に表示:
  ```
  🏛 伊勢原市役所
  ```
- 駅(Phase 1)と建物(Phase 2)が両方ある場合の優先順位を決めておく。**近い方を出す**でよい。

## Phase 3(別回にする):Overpassクエリに名所を足す

**⚠ Phase 1・2 の実機確認が終わってから、独立した回として着手すること。**

- 追加候補:`node|way["historic"]`、`node|way["tourism"~"attraction|museum|viewpoint"]`、`way["amenity"~"place_of_worship"]`
- **必ず独立した低優先度クエリにする。** 道路・建物のクエリに相乗りさせない。道路タイルの停滞は過去に何度も苦しんだ領域([[project_isehara_game_road_tile_stall_fixes]])なので、既存の隔離キュー / dormant の考え方に倣って「道路・建物が終わってから投げる」形にする。
- **判定基準:道路タイルの生成レイテンシが悪化しないこと。悪化したら即 revert。**

## Phase 4(当面やらない):3D空間内のラベル

- `THREE.Sprite` + `CanvasTexture` で名前を空中に浮かべる案。
- やる場合は**最初から上限を設計に入れる**:同時表示は最大5個・距離順・一定距離以上は非表示。数を増やす機能に個別上限を付けないと破綻することは既に学習済み([[feedback_per_building_decoration_budget]])。

---

## やらないこと

- **住所表示(Nominatim)の更新頻度を上げない。** BAN リスクがある。
- Phase 1〜2 の段階で通信を増やさない。

## 完了判定

- Phase 1:伊勢原駅の周囲300mを歩くと駅名と距離が出る。離れると消える。
- Phase 2:市役所・学校・病院など name のある建物の前で名前が出る。**かつタイル生成のレイテンシと FPS に変化がない**。
- 遠方へジャンプして戻ってきても、古い場所の名前が残っていない(破棄が効いている)。
- 日本語・英語の両方で表示が崩れない(OSMの `name` は現地語なのでそのまま出す。`name:ja` があれば優先してよい)。
