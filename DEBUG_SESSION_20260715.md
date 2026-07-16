# デバッグセッション記録 2026-07-15

前回セッション(道路拡張生成の停止調査、GENERATION_PIPELINE.md作成)からの続き。
「道路の拡張生成が完全にストップしている」という報告を起点に、複数回の診断・修正を行った。

## 1. 414 Request-URI Too Long によるタイル取得の全面停止(最重要)

**症状:** 道路・建物の拡張生成が完全に停止。水域(川)だけは拡張されて見える。

**診断:** ユーザーの実ブラウザ(バックグラウンド化されていない本物のタブ)で以下を実行し、
コンソールに直接証拠が出た。

```js
JSON.stringify({
  hidden: document.hidden,
  osmTileQueue: osmTileQueue.length,
  osmTileActiveCount,
  fetchedOSMTiles: fetchedOSMTiles.size,
  loadedOSMTiles: loadedOSMTiles.size,
  pendingRoadMeshes: pendingRoadMeshes.length,
  pendingBuildings: pendingBuildings.length,
  failCounts: Array.from(osmTileFailCount.entries()),
  playerX: player.position.x, playerZ: player.position.z,
})
```

結果: `pendingRoadMeshes:0, pendingBuildings:0`(メッシュ化待ちキューには何も詰まっていない)
なのに `osmTileQueue:68` かつ複数タイルの失敗回数が7〜11回。コンソールには
`net::ERR_FAILED 414 (Request-URI Too Long)` と、それに付随するCORSブロックのエラーが
大量に出ていた。

**根本原因:** `fetchOSMTileBatch()`(part8.js)がOverpassクエリをGETでURLに埋め込んでいた
(`?data=<encodeURIComponent(query)>`)。6タイルまとめ×13種類程度のfeature節
(highway/building/relation building/landuse/leisure/natural/waterway/relation water/
riverbank/railway/station/halt/public_transport/amenity)を含むクエリは数千文字に達し、
overpass-api.deがGETのURL長制限で414を返していた。これはプロキシ経由(server.js側も
GETベースのhttps.getだったため同様に414になり得る)・ブラウザ直接アクセスの両方で発生。
川(水域ポリゴン)は`processWaterRelation`が同期描画のため、たまたま届いた断片データからでも
少しずつ増えて見えていただけで、実際は道路も建物もほぼ同じ理由でブロックされていた。

**修正:** OverpassへのリクエストをGET→POST(ボディに`data=<クエリ>`)に統一。
- `js/legacy/part8.js` `fetchOSMTileBatch()`: `fetch(url, {method:'POST', headers, body, signal})`に変更。
- `server/server.js`: `httpsGetOnce`→`httpsRequestOnce(urlStr, opts)`に拡張し
  `https.request`でGET/POST両対応。`fetchUpstream`/`fetchUpstreamMulti`はopts透過。
  `handleApi`はPOSTボディを読み取り(`readRequestBody`)、キャッシュキーもURL文字列ではなく
  ボディ内容ベースに変更し、上流へもPOSTで転送。

これによりURL長がボトルネックになることが原理的になくなった。

## 2. 直接アクセスモードのレート制限欠如(1の修正後に発覚)

**症状:** 1の修正後、道路拡張は概ね正常化したが、しばらく動き回ると再び長時間ストップする
ことがある、との報告。

**診断ツール:** ブラウザコンソールに貼り付ける定期スナップショット+詰まり自動検知スクリプトを
作成し、ユーザーの実タブで実行してもらった(`window.__diag`配列に2秒おきに記録、
`window.__diagTimer`で停止可能)。ログには`direct @ (index):25`(プロキシではなくブラウザ→
overpass-api.de直接)経由で`429 (Too Many Requests)`→さらに`net::ERR_CONNECTION_TIMED_OUT`
が連発している様子が記録された。`osmTileQueue`が90〜100台で高止まりし、同じ数タイルの
失敗回数が9→10→11と増え続けていた。

**根本原因:** `index.html`に注入されるプロキシ書き換えスクリプト(server.js内`INJECT`)には
「プロキシが一度でも5xx/エラーを返すと、以後そのタブはずっとブラウザ→上流の直接アクセスに
切り替わる(`proxyDown[prefix]=true`が恒久フラグ)」という設計があった。直接モードには
サーバー側のような1.1秒間隔のレート制限が一切無いため、プレイヤーが速く動き回って新規タイル
要求が増えると連投になり、Overpass公開インスタンス(1IPあたり同時実行枠2、という制限)に
自分から突っ込んでいた。しかも一度その状態になると自己回復しない設計だった。

**修正:** `server/server.js`の`INJECT`スクリプトを変更。
- `direct()`にサーバーと同じ1100ms間隔のペース配分を追加(`lastDirectAt`マップ)。
- `proxyDown[prefix]`を恒久boolean→タイムスタンプに変更し、2分(`PROXY_RETRY_MS`)経過後は
  自動でプロキシへの復帰を試すようにした。

## 3. 電柱・電線の撤去(装飾のみで無駄なリソース消費と判断)

`js/legacy/part4.js`の`decorateRoad()`内の電柱・街灯オーブ・電線生成ループ、
`js/legacy/part2.js`の`PROP_WIRES`/`wireMesh`/`addWireSeg`/`setWireSegY`、
`js/legacy/part1.js`の`resnapWireSpan`を全て削除。`poleP`/`lampP`のインスタンスプールは
街灯・信号機・建物の照明で共用しているため維持。

## 4. 道路/建物の生成優先度の見直し

- 道路メッシュキュー(`pendingRoadMeshes`)・建物キュー(`pendingBuildings`)ともに、
  プレイヤー位置基準で定期再ソート(30フレームごと)を追加。
- 道路メッシュの1フレーム処理時間をバックログに応じて6〜24msにスケール(以前は固定6ms)。
- 建物側のバックログが道路より優先されすぎないよう、道路バックログ>80のときは建物の
  1フレーム処理数を5に制限。
- 建物の生成距離(`BUILDING_GEN_DIST`=800m)は維持、消去距離(`BUILDING_UNLOAD_DIST`)を
  1000m→1500mに拡大(ヒステリシス帯が狭すぎて斜め移動で再生成/消去を繰り返していたため)。

## 5. 遠景建物の生成抑制(リソース最適化)

実在(`real:true`)の建物は、プレイヤーから`BUILDING_GEN_DIST`(800m)より遠い場合は
生成そのものを見送り、`dormantBuildings`配列に退避。`reactivateNearbyDormantBuildings()`
(90フレームごと)がプレイヤー接近を検知して`pendingBuildings`へ戻す。地形・道路・線路・川は
従来通り2500mまで生成(遠景として十分という判断)。

## 6. 駅密集による強制高層ビル化を無効化

`js/legacy/part2.js`の`isStationHubNear`(半径1000m以内に駅ノード2つ以上でターミナル駅
とみなし`denseHighRise`プロファイルを強制)を、`STATION_HUB_ENABLED = false`フラグで
無効化。都会な地域は実際のOSM建物データ(高さ/階数タグ)で十分なはず、との判断。
ロジック自体は残しており、フラグを`true`に戻せば再度有効化できる。

## デバッグ用ツール(今後の調査に再利用可能)

ブラウザの実タブ(バックグラウンド化されていないこと必須)のコンソールに貼り付けて使う
定期診断ロガー。2秒おきにOSMタイル/道路/建物キューの状態を記録し、詰まりを自動検知する。

```js
window.__diag = window.__diag || [];
if (window.__diagTimer) clearInterval(window.__diagTimer);
let _prev = null, _stallCount = 0;
window.__diagTimer = setInterval(() => {
  const snap = {
    t: new Date().toISOString().slice(11, 19),
    hidden: document.hidden,
    px: Math.round(player.position.x), pz: Math.round(player.position.z),
    osmQueue: osmTileQueue.length, osmActive: osmTileActiveCount,
    fetched: fetchedOSMTiles.size, loaded: loadedOSMTiles.size,
    roadMesh: pendingRoadMeshes.length,
    buildBacklog: pendingBuildings.length - pendingBuildingIdx,
    dormant: dormantBuildings.length,
    chunkQueue: (typeof chunkGenQueue !== 'undefined') ? chunkGenQueue.length : 'n/a',
    nearReady: (typeof nearElev !== 'undefined') ? !!nearElev : 'n/a',
    failTop: Array.from(osmTileFailCount.entries()).sort((a,b)=>b[1]-a[1]).slice(0,5),
  };
  window.__diag.push(snap);
  if (window.__diag.length > 300) window.__diag.shift();
  if (_prev) {
    const roadStuck = snap.roadMesh > 0 && snap.roadMesh === _prev.roadMesh;
    const buildStuck = snap.buildBacklog > 0 && snap.buildBacklog === _prev.buildBacklog;
    const osmStuck = snap.osmQueue > 0 && snap.osmActive === _prev.osmActive && snap.fetched === _prev.fetched;
    if (roadStuck || buildStuck || osmStuck) {
      _stallCount++;
      if (_stallCount === 3) console.warn('⚠️ STALL DETECTED', { roadStuck, buildStuck, osmStuck, snap });
    } else { _stallCount = 0; }
  }
  _prev = snap;
}, 2000);
console.log('診断ロガー開始。停止: clearInterval(window.__diagTimer)');
console.log('ログ取得: copy(JSON.stringify(window.__diag))');
```

## 教訓

- 「Aは拡張されるがBは拡張されない」という報告は、AとBが同じOSMタイル取得を共有していても
  片方が同期処理・片方がフレーム分割キューだと、キューの詰まりが片方だけに見える形で
  現れることがある(今回は水域=同期描画、道路/建物=キュー経由)。
- GETでクエリをURLに埋め込む方式は、クエリが大きくなるほどURL長制限(414)という
  分かりにくい失敗モードに繋がる。複数タイル・複数feature種別をまとめるようなクエリは
  最初からPOST-with-bodyにしておくのが安全。
- クライアント側の「プロキシ失敗→直接アクセスへの永久フォールバック」は、直接アクセス側に
  同等のレート制限・自己回復機構が無いと、一時的な不調が永続的な詰まりに転化してしまう。
- Claude-in-Chromeの自動操作タブは`document.hidden=true`になりがちで、
  `requestAnimationFrame`ループやタイマーが止まる/極端に遅延するため、生成停止系の不具合は
  ユーザー自身の実タブで再現・診断してもらうのが確実。
