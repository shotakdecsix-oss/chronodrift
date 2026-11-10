# ARCHITECTURE

## 全体
- `index.html`: HUD（CSS込み）と、スクリプトを順に読み込むだけのページ。ビルド工程はない。
- `js/legacy/part1〜10.js`: ゲーム本体。ESモジュールではなくクラシックスクリプトで、トップレベルの let/const/function は全ファイル共有のグローバル。読み込み順に依存する（後のファイルで宣言される変数を、前のファイルの起動時処理から参照しないこと）。
- `js/core/`: 独立した小さなモジュール。mode-registry（モード切替）、audio（環境音）、perf-hud（性能表示）、wake-lock（画面スリープ防止）、bldg-batch（建物のまとめ描画）、road-batch（道路と外形ポリゴンの建物のまとめ描画）、shop-signs（店名の看板）、vt（地図データ: ベクタータイル→Overpass形式の要素に変換。part8.jsのfetchOSMTileBatchが最初に呼ぶ）。
- `js/lib/pure.js`: DOMにもthree.jsにも依存しない純関数。`test/` でユニットテストする。
- `server/server.js`: 静的配信（gzip＋ETag）と、外部APIのプロキシ兼キャッシュ（/api/overpass、/api/elevation、/api/nominatim）。
- `scripts/check-syntax.js`, `test/`, `.github/workflows/ci.yml`: `npm test` と GitHub Actions。

## part ファイルの主な担当
| ファイル | 内容 |
|---|---|
| part1 | 設定・i18n、レンダラ/シーン/カメラ、空、ライトと時間帯、衝突グリッド、道路メッシュ化キュー、建物のアンロードと休眠、プレイヤー |
| part2 | マテリアルとテクスチャ（ファサード等）、共有ジオメトリ、国別建物プロファイル、小物のInstancedMeshプール、OSMタグ→建物スタイル |
| part3 | 建物の描画（addBuilding）、ランドマーク、道路・線路・橋のジオメトリ |
| part4 | 駅名看板、面（公園・水域・田畑）、水面、海岸線 |
| part5 | 地形（遠景メッシュ、標高タイル、getGroundY） |
| part6 | 地域の基準点、近傍・広域の標高取得、海面 |
| part7 | UI（地図ジャンプ、検索、設定、GPS追従のUI、ミニマップ） |
| part8 | OSMタイルの取得と解析（processTileData）、手続き生成（generateChunk） |
| part9 | メインループ（animate）、探索・GPS追従モード、デバッグ表示 |
| part10 | 経路シミュレーション（OSRM） |

## データの流れ（現実モード）
OSMタイル（1.6km四方）をOverpassから取得 → processTileData で道路・建物・面を記録 → 建物は pendingBuildings に積まれ、animate が1フレームごとの予算内で addBuilding → 遠ざかると休眠（記述子だけ残す）→ 再接近で再生成。地形は国土地理院の標高タイルから200m格子の遠景メッシュを作り、getGroundY はその面を返す。
