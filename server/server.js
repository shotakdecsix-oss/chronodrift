#!/usr/bin/env node
/**
 * ChronoDrift ローカルサーバ (プロトタイプ)
 * - 静的ファイル配信 (ゲーム本体 = 親フォルダの index.html)
 * - /api/elevation/* -> https://api.opentopodata.org/* のプロキシ+ディスクキャッシュ
 * - /api/overpass?*  -> https://overpass-api.de/api/interpreter?* のプロキシ+ディスクキャッシュ
 * - index.html 配信時に fetch を書き換える小スクリプトを注入 (index.html 自体は無変更)
 * - 上流へは 1.1 秒間隔のレート制限を厳守。キャッシュヒットは即応答
 *
 * Node.js 標準モジュールのみ使用。npm install 不要。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const HOST = '0.0.0.0';
const ROOT = path.join(__dirname, '..');          // ゲーム本体 (index.html のある場所)
const CACHE_DIR = path.join(__dirname, 'cache');
const MIN_INTERVAL_MS = 1100;                     // 上流レート制限 (1req/秒 + 余裕)
const UPSTREAM_TIMEOUT_MS = 45000;
const MAX_ATTEMPTS = 3;
// 【2026-07-25・詰まり検出→強制打ち切り】(当時はレーン方式。現在は優先度付き待ち行列+
// ワーカー2本。下のscheduleUpstream参照)並列度を上げても、全ワーカーが同時に「遅いが
// 最終的には応答する」リクエストで埋まってしまえば根本的には同じ「詰まり」が起きる
// (ユーザー指摘のとおり)。並列度を際限なく上げる代わりに、このホスト宛ての待ち件数
// (詰まりの兆候)が閾値を超えている間は
// 1回のリクエストの持ち時間そのものを短くし、強制的に見切りをつけてレーンを早く手放す。
// 平常時は従来どおり寛容な45秒(密集地の正常な低速応答を誤って打ち切らない)を維持し、
// 詰まっている時だけ短縮する。
// 【2026-07-27・IMPL_PROMPT_20260727 Step A-1】Phase1(近傍クエリ分離)導入後、通常のエリア
// 充填だけで約34本(3x3分離18+5x5外周ソロ16)のリクエストが発生するようになり、旧値6だと
// 平常時から常時「詰まり」判定になってしまっていた(=正常な密集地の応答2〜10秒を
// 5秒打ち切りで潰し、失敗→バックオフ→再試行が渋滞を自己維持する自己渋滞)。平常のエリア
// 充填(30本超)を詰まりと誤認しない値まで引き上げる。
const CONGESTION_BACKLOG = 20;      // このホスト宛ての待ち件数がこれを超えたら「詰まり」とみなす
// 【2026-07-25(2)・ユーザー相談】当初は一律20秒にしていたが、3タイルまとめクエリは正常時
// でも10〜30秒かかる実測があり、一律20秒だと詰まり中はまとめクエリのほとんどが正常応答でも
// 間に合わず失敗→即リトライになり、Overpassへのリクエスト数がかえって増えて詰まりを悪化
// させかねない(429ストームの自己増幅と同じ構図)。1タイル単体クエリ(正常時1〜2秒)と
// 3タイルまとめ(正常時10〜30秒)とでは許容できる打ち切りの短さが全く違うため、
// クエリが自己申告しているOverpass側timeout([timeout:N]、1タイル=20/26秒・3タイルまとめ=
// 30/38秒。buildOSMBatchQuery(part8.js)参照)を見て使い分ける。
// 【2026-07-27・IMPL_PROMPT_20260727 Step A-1】5000だと密集地のソロクエリの正常応答
// (2〜10秒)まで打ち切ってしまい、失敗→再試行が渋滞を悪化させていた。12秒まで緩和。
const CONGESTED_TIMEOUT_MS_SOLO = 12000;  // 詰まり中・1タイル単体クエリの持ち時間
const CONGESTED_TIMEOUT_MS_BATCH = 20000; // 詰まり中・複数タイルまとめクエリの持ち時間(従来値のまま)
const SOLO_QUERY_TIMEOUT_SEC_MAX = 28; // これ以下ならクエリ自己申告timeoutから「1タイル単体」とみなす
// 【2026-07-27】1リクエストがクライアントへ応答を返すまでの自主的な上限。Renderのエッジが
// 長すぎるリクエストを502にしてしまう前に、自分で504(+X-Proxy-Health)を返して切り上げる。
// UPSTREAM_TIMEOUT_MS(45秒)×MAX_ATTEMPTS+ミラー巡回を全部足すと100秒を超え得るため必須。
// 進行中の上流取得は打ち切らない(完了すればキャッシュに入り、次の再試行がHITになる)。
const PROXY_SOFT_DEADLINE_MS = 60000;

// ---------- デプロイ日時 ----------
// Renderはデプロイのたびにこのプロセスを新しく起動し直すため、プロセス起動時刻が
// 実質的な「デプロイ日時」として使える。ビルドコマンドが無い(echo no build)ため
// ビルド時刻を別途記録する手段が無く、これが最も簡単で確実。
// あわせて .git が残っていれば直近コミットのハッシュ・日時も拾う(無ければnullのまま)。
const DEPLOY_TIME = new Date();
let DEPLOY_COMMIT = null, DEPLOY_COMMIT_TIME = null;
try {
  DEPLOY_COMMIT = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  DEPLOY_COMMIT_TIME = execSync('git log -1 --format=%cI', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch (_) { /* gitが無い/取得失敗時はプロセス起動時刻だけを使う */ }

// Overpassはメインの overpass-api.de が混雑/不調になることがあるため、
// 独立運営の別ミラーへのフォールバックを用意する(2026-07: 香港・上海等で
// overpass-api.de がプロキシ経由・ブラウザ直接の両方でタイムアウトする事象を確認)。
// 東京(伊勢原)がテストで問題なく見えていたのは、直近の試行が既にディスクキャッシュに
// 乗っていて上流に問い合わせずに済んでいただけの可能性が高く、地形データが国によって
// 恒久的に取得不可というわけではない。
// 【2026-07-19・実験→撤回】private.coffeeをメインにする実験を行ったが、実機のRenderログで
// private.coffee/kumi.systemsが「毎回」upstream timeout(45秒待ちを2回=最大90秒超)になり、
// overpass-api.deだけが(429/504はあるものの)唯一実際に200を返せていることが確認された
// (この間/api/overpassの応答が最大881秒=約15分にまで悪化)。「レート制限なし」という
// サードパーティの説明は少なくとも今この瞬間のRenderの環境からは成立しておらず、むしろ
// 常に失敗する2本を毎回律儀に試す分だけ確実に遅くなっていた。overpass-api.deを先頭へ戻す。
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const APIS = {
  '/api/elevation': { upstream: 'https://api.opentopodata.org', dir: 'elevation' },
  '/api/overpass':  { upstream: OVERPASS_MIRRORS[0], dir: 'overpass', mirrors: OVERPASS_MIRRORS },
  '/api/nominatim': { upstream: 'https://nominatim.openstreetmap.org/reverse', dir: 'nominatim' }, // 現在地の住所表示(逆ジオコーディング)用
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/* ---------- デプロイ情報をゲーム側へ渡すスクリプト ----------
 * ?ヘルプパネルから確認できるよう window.__DEPLOY_INFO__ に載せる。
 */
const DEPLOY_INFO_SCRIPT = `<script>window.__DEPLOY_INFO__ = ${JSON.stringify({
  time: DEPLOY_TIME.toISOString(),
  commit: DEPLOY_COMMIT,
  commitTime: DEPLOY_COMMIT_TIME,
})};</script>`;

/* ---------- index.html に注入するスクリプト ----------
 * - opentopodata / overpass への fetch を同一オリジンのプロキシに書き換え
 * 【削除済み・CODE_REVIEW_20260717 P2】旧クライアントのレート制限待ち(1100/1500ms)を
 * キャッシュHIT時に短縮するwindow.setTimeoutパッチがあったが、対象のsetTimeoutは既に
 * 存在せず、part6.js側のPromise.race([updateAddressDisplay(), setTimeout 1500ms])に誤爆
 * していた(キャッシュHIT時に国コード取得の猶予が15msに切り詰められる副作用があった)。
 */
const INJECT = `<script>
(() => {
  const MAP = [
    ['https://api.opentopodata.org', '/api/elevation'],
    ['https://overpass-api.de/api/interpreter', '/api/overpass'],
    ['https://nominatim.openstreetmap.org/reverse', '/api/nominatim'],
  ];
  // プロキシ経由が上流に拒否された(5xx)APIは、以後ブラウザ→上流の直接アクセスに切り替える。
  // 【背景】Renderなど共有IPのホスティングはOverpass等の公開APIにIP単位で拒否/制限される
  // ことがある(2026-07: Render経由のOverpassが502連発→道路が格子状フォールバックになる
  // 症状の原因)。上流はいずれもCORS対応なのでブラウザから直接叩け、その場合は各プレイヤー
  // 自身のIPでレート制限枠を使うため、共有IPよりむしろ通りやすい。
  // プロキシが健在な間は従来どおりプロキシ+ディスクキャッシュを使う(ローカルで有効)。
  //
  // 【重要・2026-07-15追記】上記の直接アクセスには元々ペース配分が無く、proxyDownも一度
  // 立つとタブの生存中ずっと直接モードに固定されていた。実機で「しばらく動き回った後に
  // 道路・線路の拡張が止まる」を診断したところ、direct()経由でoverpass-api.deに429
  // (Too Many Requests)→さらに悪化してnet::ERR_CONNECTION_TIMED_OUT(一時的な接続拒否)
  // が連発しているのを確認。サーバ側は1.1秒間隔厳守だが、直接モードにはその制約が無いため
  // プレイヤーが速く動き回ってタイル要求が増えると連投になり、Overpass公開インスタンス側の
  // レート制限に自分から突っ込んでいた。かつ一度そうなると詰まったまま自己回復しない。
  // → (1) 直接モードにも同じ1.1秒間隔のペース配分を追加、(2) proxyDownを恒久フラグではなく
  // タイムスタンプにし、一定時間後にプロキシへの復帰を自動で試みるようにする。
  // 【2026-07-27・直接モードの廃止(Overpassのみ)】7回の実測が一貫して示したのは、
  // 直接モードへ落ちた回は例外なく悪化するという事実:
  //   プロキシ経由 … ディスクキャッシュ○ / inflight束ね○ / レート枠=Renderの共有IP
  //                  実測 PROXY=9 が全て200、R tier2=10.2秒
  //   直接モード   … 上記すべて無効 / レート枠=【ユーザー自身の2スロット】
  //                  実測 429・504 が半数、Rはサンプルすら取れず
  // 「1回の接続失敗で10分間、確実に悪い経路へ倒す」よりも「失敗させてタイル別backoffで
  // 再試行させる」方が期待値が高い(上流の一時的な不調なら次の試行で通る)。
  // よってOverpassについては直接モードへのフォールバックを行わない。
  // elevation/nominatimは直アクセスで問題が出ていないので従来どおり(そちらのために
  // direct()とproxyDownの仕組み自体は残す)。
  const NO_DIRECT_FALLBACK = {}; // prefix -> true(下でOVERPASS_PREFIXを登録)
  const proxyDown = {};
  // 【2026-07-27】プレフィックスごとの「次にプロキシへ復帰を試すまでの待ち時間」。
  // 通常の不調は120秒(PROXY_RETRY_MS)、上流到達不能(X-Upstream-Unreachable)は
  // 分単位で続く状態なのでUNREACHABLE_RETRY_MSを使う。
  const proxyRetryMs = {};
  const lastDirectAt = {};
  const DIRECT_MIN_INTERVAL_MS = 1100; // サーバ側のMIN_INTERVAL_MSと揃える
  const PROXY_RETRY_MS = 120000; // 2分ごとにプロキシへの復帰を試す(一時的な不調で永久固定されないように)
  const UNREACHABLE_RETRY_MS = 600000; // 上流到達不能時は10分。120秒ごとの再挑戦は毎回3並列×20〜30秒を空費するだけだった
  // 【重要・2026-07-16】direct()の「最終アクセス時刻を見てwait時間を計算→sleep→時刻更新」は
  // 単純な read-modify-write で、呼び出し側(part8.jsはOSM_TILE_CONCURRENCY=2で並行に
  // fetchOSMTileBatchを呼ぶ)が同時に2回direct()を呼ぶと、両方とも更新前の古いlastDirectAtを
  // 読んでほぼ同じwait時間を計算し、ほぼ同時にorigFetchを発火してしまう競合状態だった
  // (実機で確認: 京橋・八重洲でdirect()経由のfetchが立て続けに429 Too Many Requestsになる
  // 事象と一致)。プレフィックスごとにPromiseチェーンで直列化し、「待つ→時刻更新」を
  // 呼び出しごとに確実に1つずつ順番に処理させる(server.js側のscheduleUpstreamと同じ考え方)。
  const directChains = {};
  // 【重要・2026-07-16】直接モードはoverpass-api.de単一ホスト固定だったため、密集地で
  // タイルのバックログが積むと1.1秒間隔でも公開インスタンスのレート制限に到達し、
  // 429/504が連発→part8.js側の失敗カウントが4に達して「諦め=永久空き地」になっていた
  // (実機コンソールで429/504の連鎖を確認)。直接モードもミラー輪番にし、429/5xx/
  // ネットワークエラーを返したミラーは一定時間除外する。ペース配分・直列化チェーンも
  // ミラー(ホスト)ごとに独立させ、健全なミラーが複数ある間は実効スループットも上がる。
  const OVERPASS_PREFIX = 'https://overpass-api.de/api/interpreter'; // part8.js側が呼ぶ元URL(書き換え対象の目印。ミラー順とは無関係)
  NO_DIRECT_FALLBACK[OVERPASS_PREFIX] = true; // 上記の理由によりOverpassは直接モードへ倒さない
  // 【2026-07-19・実験→撤回】private.coffeeを先頭にする実験はRenderの実機ログで
  // private.coffee/kumi.systemsが常時タイムアウトすることが確認されたため撤回。
  // overpass-api.deを先頭に戻す(server.js側のOVERPASS_MIRRORSと同じ理由)。
  const OVERPASS_DIRECT_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  const mirrorBackoffUntil = {}; // ミラーURL -> このtimestampまで使わない
  const paceThrough = async (chainKey) => { // chainKeyごとに1.1秒間隔を直列で保証
    const prevChain = directChains[chainKey] || Promise.resolve();
    const myTurn = prevChain.then(async () => {
      const wait = (lastDirectAt[chainKey] || 0) + DIRECT_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastDirectAt[chainKey] = Date.now();
    });
    directChains[chainKey] = myTurn.catch(() => {}); // 1件失敗してもチェーンは継続
    await myTurn;
  };
  // 【2026-07-27・実測に基づく追加】直接モードのpaceThroughは「開始を1.1秒ずつ離す」だけで
  // 同時本数を絞っていなかった。1本が4〜9秒(密集地は10〜30秒)かかるため、part8側の
  // OSM_TILE_CONCURRENCY=3で常に3本が重なり、Overpassの「1IPあたり2スロット」を構造的に
  // 超えて429を踏み続けていた(実測: 200が4.5秒/8.6秒で返る一方、3本目が429。
  // かつ /api/status が rate limit=2, available now=0 を報告)。
  // ホストごとに同時2本までのゲートを設ける。paceThrough(開始間隔)とは別の制約で、
  // 「同時に走る本数」を上流の実態に合わせる。
  const DIRECT_MAX_CONCURRENT = 2;
  const directActive = {};   // ホスト(chainKey) -> 実行中の本数
  const directWaiters = {};  // ホスト(chainKey) -> 解放待ちのresolve配列
  const acquireSlot = async (key) => {
    if ((directActive[key] || 0) < DIRECT_MAX_CONCURRENT) { directActive[key] = (directActive[key] || 0) + 1; return; }
    await new Promise((r) => { (directWaiters[key] = directWaiters[key] || []).push(r); });
    directActive[key] = (directActive[key] || 0) + 1;
  };
  const releaseSlot = (key) => {
    directActive[key] = Math.max(0, (directActive[key] || 1) - 1);
    const w = directWaiters[key];
    if (w && w.length) w.shift()();
  };
  // ===== コールドスタート(Render無料プランのスピンダウン)対策 =====
  // 【2026-07-27・実測で判明した最重要の機序】15分無アクセスでインスタンスが停止し、復帰に
  // 実測39秒かかる。その間 /api/* へのリクエストにはRenderのエッジが "Application loading" の
  // HTML(5xx・X-Proxy-Healthヘッダ無し)を返す。これは下の proxyDown 判定
  // 「X-Proxy-Health の無い5xx = プロキシ故障」にそのまま合致するため、
  //   ゲーム起動 → 最初の1本が loading HTML → proxyDown ラッチ → セッション丸ごとDIRECT
  // という流れで【毎セッションの冒頭が構造的に縮退経路から始まっていた】。
  // 直近の計測が全リクエストDIRECTだったのもこれで説明が付く。
  // 対策は2段構え:
  //   (1) 暖機: 上流に触らない /api/ping が200を返すまで、プロキシ経路のfetchを保留する。
  //       起動待ちの間はタイル取得を一切走らせないので、loading HTMLを掴むことがそもそも無い。
  //   (2) 署名分離: それでも掴んでしまった場合に備え、「5xx かつ X-Proxy-Health 無し かつ
  //       Content-Typeがtext/html」= 起動中 と見なし、proxyDownを立てずにリトライする。
  //       単発リトライでは同じloading窓に再着弾するだけなので、間隔を空けて粘る。
  const SERVER_WAKE_TIMEOUT_MS = 90000; // 起動待ちの上限(実測39秒に十分な余裕)
  const SERVER_WAKE_POLL_MS = 3000;
  let _wakeBanner = null;
  const showWakeBanner = () => {
    if (_wakeBanner || !document.body) return;
    _wakeBanner = document.createElement('div');
    _wakeBanner.textContent = 'サーバー起動中… (最大1分ほどかかります)';
    _wakeBanner.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:99999;' +
      'background:rgba(20,20,28,.88);color:#fff;font:13px/1.6 sans-serif;padding:8px 16px;border-radius:8px;' +
      'pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,.4)';
    document.body.appendChild(_wakeBanner);
  };
  const hideWakeBanner = () => { if (_wakeBanner) { _wakeBanner.remove(); _wakeBanner = null; } };
  // スクリプト読み込み直後に開始する(最初のタイル取得より必ず前になる)
  const serverReady = (async () => {
    const started = Date.now();
    let shownBanner = false;
    while (Date.now() - started < SERVER_WAKE_TIMEOUT_MS) {
      try {
        const r = await fetch('/api/ping', { cache: 'no-store' });
        // 【重要】r.ok(=2xx)だけで判定してはいけない。Renderのエッジが返す
        // "Application loading" ページは200で返る可能性があり、その場合ここが即trueになって
        // 暖機が丸ごと無効化される(そして下のisColdStartResponseもstatus<500で素通りするため、
        // loading HTMLが正常なOverpass応答としてpart8へ渡り、JSON.parse例外=「原因不明の
        // タイル取得失敗」に化けて診断が難しくなる)。
        // /api/pingは自分で組み立てた応答なので必ず X-Proxy-Health を持つ。これを見れば
        // ステータスが200でも503でも「自分の応答か、エッジが割り込んだか」が確定する
        // (isColdStartResponseと判定軸が揃う)。
        if (r.ok && r.headers.get('X-Proxy-Health')) { hideWakeBanner(); return true; }
      } catch (_) { /* 起動中は接続エラーもあり得る */ }
      if (!shownBanner && Date.now() - started > 2500) { shownBanner = true; showWakeBanner(); }
      await new Promise((r) => setTimeout(r, SERVER_WAKE_POLL_MS));
    }
    hideWakeBanner();
    return false; // 上限まで待っても起きない=本当に落ちている。以降は通常判定に委ねる
  })();
  // 起動中(loading HTML)かどうかの署名判定。
  // 【2026-07-27】ステータスの下限は設けない。Renderの "Application loading" が200で返る
  // 可能性があり、status>=500 を条件にすると素通りしてしまうため。
  // /api/* に対する自前の応答は【全経路で】X-Proxy-Health を付けている(キャッシュHIT・
  // 上流結果の中継・ソフトデッドライン504・handleApiのcatch 502・トップレベルの500)。
  // よって「X-Proxy-Healthが無く、かつHTMLが返ってきた」= Renderのエッジが割り込んだ
  // =起動中、と断定でき、ステータスを問わず安全に判定できる。
  const isColdStartResponse = (res) => {
    if (res.headers.get('X-Proxy-Health')) return false; // 自前で組み立てた応答=プロセスは生きている
    // 【注意・2026-07-27に実際に踏んだ罠】ここで正規表現リテラルを使ってはいけない。
    // INJECTはテンプレートリテラルなので、ソースの \/ は配信時に / へ潰れ、
    // /text\/html/i が /text/html/i として出力されて "Invalid regular expression flags" で
    // INJECT全体がパースエラーになる(=URL書き換えも暖機も全部死に、全リクエストが
    // 素のoverpass-api.deへ飛ぶ。実機で PROXY=0 / DIRECT=11 として観測された)。
    // 素の文字列判定にしておけばエスケープの数え間違いが構造的に起こらない。
    const ct = (res.headers.get('Content-Type') || '').toLowerCase();
    return ct.indexOf('text/html') >= 0;
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    let url = (typeof input === 'string') ? input : (input && input.url) || '';
    for (const [prefix, local] of MAP) {
      if (url.startsWith(prefix)) {
        const direct = async () => {
          if (prefix === OVERPASS_PREFIX) {
            const now = Date.now();
            let mirror = null;
            // 配列先頭(overpass-api.de)から順に健全なものを選ぶ。他ミラーはbackoff中の
            // フォールバック用(private.coffee/kumi.systemsは実測で常時タイムアウトしたため
            // 先頭には置かない。詳細は[[project_isehara_game_overpass_mirror_experiment]]参照)。
            for (let i = 0; i < OVERPASS_DIRECT_MIRRORS.length; i++) {
              const cand = OVERPASS_DIRECT_MIRRORS[i];
              if ((mirrorBackoffUntil[cand] || 0) < now) {
                mirror = cand;
                break;
              }
            }
            if (!mirror) {
              // 【2026-07-17・Fable5診断】以前は全滅時に無条件で本家固定へ戻していたため、
              // 直前に429/5xxを食らったばかりの相手へ延々投げ続け、429ストームを
              // 自ら悪化させていた(実機ログ: overpass-api.deへの429が連発)。
              // 3つのうち最もbackoffの明けが早いものを選ぶ(どのみち枠は埋まっているので
              // 「一番マシな相手」を選ぶだけ。実際の間隔調整はpart8側の再試行
              // バックオフに任せる方針自体は変えない)。
              mirror = OVERPASS_DIRECT_MIRRORS.reduce((best, cand) =>
                (mirrorBackoffUntil[cand] || 0) < (mirrorBackoffUntil[best] || 0) ? cand : best,
                OVERPASS_DIRECT_MIRRORS[0]);
            }
            await acquireSlot(mirror); // 上流の同時スロット数(2)を超えないようにする
            try {
            await paceThrough(mirror);
            try {
              const res = await origFetch(mirror + url.slice(prefix.length), init);
              if (res.status === 429) mirrorBackoffUntil[mirror] = Date.now() + 60000;
              else if (res.status >= 500) mirrorBackoffUntil[mirror] = Date.now() + 30000;
              return res;
            } catch (e) {
              // CORS非対応ミラーや一時的な接続拒否もここに来る。除外して呼び出し側に再試行させる。
              mirrorBackoffUntil[mirror] = Date.now() + 30000;
              throw e;
            }
            } finally { releaseSlot(mirror); } // 成功・失敗どちらでも必ず枠を返す
          }
          await paceThrough(prefix);
          return origFetch(url, init);
        };
        // 【2026-07-27・A/B用の逃げ道】コンソールから window.__FORCE_DIRECT_OVERPASS__ = true
        // にすると、Overpassだけプロキシを通さずブラウザ直アクセスにする(リロードで解除)。
        // 目的: Render→Overpassの接続失敗率が60〜75%と判明した一方、ブラウザからは
        // 到達できている(429=届いている)ため、どちらが実際に速いかを実測で比べたい。
        // 直接モードを廃止した時の判断材料はOSM_TILE_CONCURRENCY=3の頃のもので、
        // 2本に修正済みの現在は前提が変わっている。デプロイせずに比較できるようにする。
        // 【2026-07-27・A/B実測に基づく既定の変更】Overpassは既定でブラウザ直アクセスにする。
        // 同一条件・同一場所で測った結果:
        //   プロキシ経由 : 21本中 成功 5 = 24%(残りは全て接続レベルの失敗 unreachable=1)
        //   直接モード   : 12本中 成功10 = 83%(失敗は429が2本のみ)
        // Renderのegressからoverpass-api.deへの接続が60〜76%失敗する一方、ブラウザからは
        // 到達できるため。以前「直接モードは常に悪い」と判断した計測は全て
        // OSM_TILE_CONCURRENCY=3 の頃のもので、2スロットに3本ぶつけて429ストームになって
        // いただけだった(同時2本に修正した現在は429は12本中2本)。
        // プロキシのディスクキャッシュ・inflight束ねは魅力だが、24%しか通らないのでは
        // 前提が成立しない。Renderのegressが改善したら window.__FORCE_PROXY_OVERPASS__ = true
        // で再評価できるようにしておく。
        if (prefix === OVERPASS_PREFIX && !window.__FORCE_PROXY_OVERPASS__) return direct();
        const downSince = proxyDown[prefix];
        if (!NO_DIRECT_FALLBACK[prefix] && downSince && (Date.now() - downSince) < (proxyRetryMs[prefix] || PROXY_RETRY_MS)) return direct();
        // 【2026-07-27・(1)暖機】プロキシ経路へ出す前にサーバーの起動完了を待つ。
        // 起動中(スピンダウンからの復帰、実測39秒)にリクエストを投げると
        // Renderのエッジが返すloading HTMLを掴み、proxyDownがラッチしてしまうため。
        // serverReadyはスクリプト読み込み直後に解決を開始しており、暖機済みなら即座に通る。
        return serverReady.then(() => proxied(0));
        // 【2026-07-27・(2)署名分離】loading HTMLを掴んでしまった場合は「故障」ではなく
        // 「起動中」なので、proxyDownを立てずに間隔を空けて再試行する(単発リトライだと
        // 同じ39秒のloading窓に再着弾して2回目も同じHTMLを掴むだけ)。
        function proxied(attempt) {
        return origFetch(local + url.slice(prefix.length), init).then(res => {
          if (isColdStartResponse(res)) {
            if (attempt < 12) { // 5秒×12 = 最大60秒粘る
              showWakeBanner();
              return new Promise((r) => setTimeout(r, 5000)).then(() => proxied(attempt + 1));
            }
            hideWakeBanner();
            // 60秒粘っても起動しない=本当に不調。従来どおり直接モードへ退避する。
            proxyDown[prefix] = Date.now();
            proxyRetryMs[prefix] = PROXY_RETRY_MS;
            return direct();
          }
          hideWakeBanner();
          // 【2026-07-27・実測診断で判明した主因】以前の条件は res.status >= 500 だった。
          // しかしプロキシは上流(Overpass)のステータスをそのまま中継する設計なので、
          // 密集地で日常的に起きる上流の504 Gateway Timeoutも「プロキシが壊れた」と誤判定し、
          // そのプレフィックスを120秒(PROXY_RETRY_MS)まるごと直接モードに落としていた。
          // 直接モードは各プレイヤー自身のIPでOverpassの2スロットを取り合うため、3並列で
          // 走るクライアントは即座に429を踏み、グローバルクールダウン→復帰→また504→また
          // 直接モード…という循環に入る。実測(2026-07-27)のコンソールがまさにこれ:
          //   /api/overpass 502 → overpass-api.de直で429/504連発 → status: available now=0
          //   → R(道路)tier2の中央値200秒、キュー101件。
          // 「プロキシ自身が壊れている」のか「プロキシは健全で上流のエラーを中継しただけ」
          // なのかを区別する必要がある。server.js側は自分が正常に応答を組み立てられた場合
          // (キャッシュヒット・上流結果の中継・自前のデッドラインによる504)には必ず
          // X-Proxy-Health: ok を付ける。このヘッダが有る限り、ステータスが5xxでも
          // プロキシ自体は生きているのでproxyDownにはしない(タイル別backoffに任せる)。
          // ヘッダが無い5xx = Renderのエッジが返した502や、プロキシの内部例外(handleApiの
          // catch)なので、従来どおり直接モードへ退避する。
          // 【2026-07-27追記】X-Upstream-Unreachable は「Renderのネットワーク経路から上流に
          // そもそも到達できない」印(DNS不能・接続拒否等。handleApi参照)。この場合だけは
          // ブラウザ直接アクセスの方が通る可能性があるため、直接モードへの退避を許す。
          // 上流の429/504/タイムアウトはこの印が付かないので直接モードには落ちない。
          const proxyAlive = !!res.headers.get('X-Proxy-Health');
          const unreachable = !!res.headers.get('X-Upstream-Unreachable');
          if (res.status >= 500 && (!proxyAlive || unreachable) && NO_DIRECT_FALLBACK[prefix]) {
            // Overpass: 直接モードへは倒さず、そのまま失敗として返す。呼び出し元
            // (part8.jsのfetchOSMTileBatch)がタイル別backoffで再試行する。
            // どの条件で退避しかけたのかは診断のため必ず残す。
            console.warn('[proxy-fail]', prefix, 'status=' + res.status,
              'health=' + (res.headers.get('X-Proxy-Health') || 'なし'),
              'unreachable=' + (res.headers.get('X-Upstream-Unreachable') || 'なし'),
              '-> 直接モードには落とさず失敗として返す');
            return res;
          }
          if (res.status >= 500 && (!proxyAlive || unreachable)) {
            // 【2026-07-27】到達不能(サーバーのegressから上流へ届かない)は分単位で続く状態
            // なので、120秒ごとに再挑戦すると そのたび3並列×20〜30秒のタイムアウトを空費する。
            // この場合だけ復帰試行の間隔を長くする(proxyRetryMsに個別の待ち時間を記録)。
            proxyDown[prefix] = Date.now();
            proxyRetryMs[prefix] = unreachable ? UNREACHABLE_RETRY_MS : PROXY_RETRY_MS;
            return direct();
          }
          proxyDown[prefix] = null; // プロキシ復帰確認
          return res;
        }, (e) => {
          // 【2026-07-27・直接モード誤発動の修正】ここは「プロキシへのfetch自体が失敗/拒否された」
          // 場合の分岐だが、init.signal(part8.js側のAbortController、近傍分離ジョブで28〜46秒・
          // 現在地タイルで70秒)がタイムアウトで中断した場合もPromiseはここで(AbortErrorとして)
          // reject される。これは「プロキシが壊れている」のではなく「クライアントが自分の
          // 我慢時間を使い切っただけ」で、サーバー側は45秒×最大3回・詰まり時はレーンが
          // 空くまでの待ち時間も加わり、正常運用でも70秒を超えて処理が続いていることがある
          // (server.js自身のUPSTREAM_TIMEOUT_MS/MAX_ATTEMPTSコメント、および過去に実測881秒で
          // 最終的に200が返ったケース参照)。これを「プロキシダウン」と誤認してdirect()に
          // 倒すと、密集地の通常の詰まりのたびにプレイヤーが2分間、各プレイヤー個別のIPで
          // Overpassの実接続上限(1IPあたり2本)へ直接勝負することになり、429ストームを
          // 自ら誘発していた(2026-07-27実機ログで確認: direct()経由の429連発とfetchingTiles
          // 滞留の同時発生)。AbortErrorの場合はproxyDownを立てず、呼び出し元(fetchOSMTileBatch
          // の既存リトライ・バックオフ)にそのまま失敗として返す。
          if (e && e.name === 'AbortError') throw e;
          if (NO_DIRECT_FALLBACK[prefix]) {
            // Overpass: プロキシへのfetch自体が失敗しても直接モードへは倒さない(上記の理由)。
            console.warn('[proxy-fail]', prefix, 'fetch例外:', (e && e.name) + ': ' + (e && e.message),
              '-> 直接モードには落とさず失敗として返す');
            throw e;
          }
          proxyDown[prefix] = Date.now();
          proxyRetryMs[prefix] = PROXY_RETRY_MS; // プロキシへのfetch自体が失敗した場合は従来どおり2分で再挑戦
          return direct();
        });
        }
      }
    }
    return origFetch(input, init);
  };
})();
</script>`;

/* ---------- ユーティリティ ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function cachePath(apiDir, upstreamUrl) {
  const h = crypto.createHash('sha1').update(upstreamUrl).digest('hex');
  return path.join(CACHE_DIR, apiDir, h + '.json');
}

/* ---------- ディスクキャッシュの有効期限・容量上限 ---------- */
// 【2026-07-26・IMPL_PROMPT_20260724 Phase4】
// 【実態確認・本書との差分】本書は「現状Overpass14日/標高30日のTTLがある」前提で
// 「延長する」よう指示していたが、実際のコード(下のhandleApi「1) キャッシュヒット」節)は
// キャッシュファイルの有効期限を一切見ておらず、書き込み時にcachedAtを記録してはいたものの
// 読み込み時に一度も参照していなかった(=ファイルが存在する限り無期限にHIT扱い)。
// Renderの無料プランはディスクがエフェメラル(再デプロイ・再起動のたびに消える)ため、
// 実質的には「今のデプロイが生きている間はキャッシュ無期限」という、本書が目指す状態を
// 既に上回る形で達成できていた。「延長する」対象の期限が実在しないため、代わりに
// 「非常に長時間デプロイし続けた場合に現実の地図変化に対してデータが古くなりすぎない」
// ための上限として、本書が挙げていた値をそのまま採用し明示的なチェックを新設する
// (無料プランの実情ではほぼ発火しない保険的な意味合いが強い)。
const CACHE_TTL_MS_BY_DIR = {
  overpass: 14 * 86400e3,   // 14日
  elevation: 30 * 86400e3,  // 30日(地形はほぼ不変)
  nominatim: 30 * 86400e3,  // 本書に記載無し。住所も変化が非常に稀なので同じ扱い
};
// 【実態確認】ディスク容量上限(LRU削除)も同様に現状は無い。本書は「永続ディスクの場合は
// 実装」という条件付きだったが、Renderがどこかのタイミングでプラン変更される可能性や
// ローカル開発での長時間起動も考慮し、低リスクな保険として常時有効にしておく
// (小さいJSON主体のキャッシュなので、通常の使用量ではまず発火しない)。
const CACHE_MAX_BYTES = 500 * 1024 * 1024; // 500MB
const CACHE_SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30分ごとにバックグラウンドで確認(リクエスト経路には絡めない)
async function sweepCacheDir() {
  try {
    let dirents;
    try { dirents = await fsp.readdir(CACHE_DIR, { withFileTypes: true }); } catch (e) { return; } // 未作成なら何もしない
    const files = [];
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const sub = path.join(CACHE_DIR, d.name);
      let names;
      try { names = await fsp.readdir(sub); } catch (e) { continue; }
      for (const name of names) {
        if (!name.endsWith('.json')) continue; // 書き込み中の.tmpは対象外
        const fp = path.join(sub, name);
        try {
          const st = await fsp.stat(fp);
          files.push({ fp, size: st.size, mtime: st.mtimeMs });
        } catch (e) { /* 削除競合等は無視 */ }
      }
    }
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= CACHE_MAX_BYTES) return;
    files.sort((a, b) => a.mtime - b.mtime); // 更新日時が古い順に削除(簡易LRU)
    let pruned = 0;
    for (const f of files) {
      if (total <= CACHE_MAX_BYTES) break;
      try { await fsp.unlink(f.fp); total -= f.size; pruned++; } catch (e) { /* 既に消えている等 */ }
    }
    log(`cache sweep: pruned ${pruned} files, now ~${Math.round(total / 1024 / 1024)}MB`);
  } catch (e) {
    log(`cache sweep failed: ${e.message}`);
  }
}
setInterval(sweepCacheDir, CACHE_SWEEP_INTERVAL_MS);
sweepCacheDir(); // 起動直後にも一度実行(前回デプロイの残骸が万一あっても早期に整理する)

/* ---------- 上流レート制限 (ホスト別・優先度付き待ち行列 + ワーカー2本) ---------- */
// 【2026-07-27・レーン方式の廃止】ここは3世代にわたって「レーン(Promiseチェーン)」方式
// だった: 完全直列1本 → 固定2レーン → 弾力レーン(2〜4本)+0番をblocking/near予約。
// しかしレーン方式には構造的な欠陥があり、レーンの本数・選び方・役割分担をどう調整しても
// 詰まりが再発し続けた(実機報告3回)。欠陥の本質は【チェーンに繋いだ時点で順番が固定され、
// 後から来た高優先度リクエストが割り込めない】こと:
//   - クライアント(part8.js)は_tileScoreで「現在地→近傍→外周」を厳密に並べているが、
//     その順位はサーバーのチェーンに繋がれた瞬間に消える。
//   - 予約レーン0も、blocking/nearが同じ`useReserved`扱いだったため、tier1(現在地)が
//     tier2の8本の後ろにチェーンされうる = 予約の意味が無かった。
//   - farは1番以降しか選べない一方クライアントはfarを2本同時に出せるため、レーン1がfarの
//     重いまとめクエリ(10〜30秒)に占有され、near/blockingは実質レーン0の1本直列だった
//     (これが「緑赤灰→緑緑赤」「緑緑赤→緑緑黄」が両方とも遅い最大要因)。
// 方式そのものを「ホストごとの優先度付き待ち行列 + 固定ワーカー2本」に置き換える。
// ワーカーは空くたびに待ち行列から blocking > near > far の順(同順位内は投入順)で取るので、
// 後から来た現在地リクエストが待機中のfarを追い越せる = 割り込み問題が消える。
// レーンの役割分担・予約・弾力拡張はすべて不要になり、far抑制はワーカー側の同時本数上限
// (FAR_INFLIGHT_MAX)で表現できる。
const UPSTREAM_WORKERS = 2;   // 上流への同時リクエスト数(overpass-api.deは1IPあたり実質2スロット)
// farが両ワーカーを同時に握ると、後から来た現在地/近傍リクエストは「待ち行列の先頭」に
// 居ても最大30秒以上開始できない(実行中のものは追い出せない)。far同時1本までに抑え、
// 残り1本を必ずblocking/nearが即座に使えるようにする。待ち行列に何も無ければfarは
// この1本を使い続けられるので、外周の先読みが恒久飢餓することはない。
const FAR_INFLIGHT_MAX = 1;
const PRIO_RANK = { blocking: 0, near: 1, far: 2 };
const pendingByHost = new Map();   // host -> 待ち行列+実行中の合計件数(詰まり検出用。意味は従来と同じ)
const hostQueues = new Map();      // host -> [{prio, seq, task, resolve, reject}]
const hostRunning = new Map();     // host -> 実行中のワーカー数
const hostFarRunning = new Map();  // host -> 実行中のうちfar優先度の件数
const hostLastStartAt = new Map(); // host -> 最後に上流リクエストを開始した時刻(MIN_INTERVAL_MSのペース配分用)
const hostPumpTimers = new Map();  // host -> ペース待ちのsetTimeoutハンドル(多重登録防止)
let _upstreamSeq = 0;
// 待ち行列から次に実行する1件を選ぶ。優先度が高い順、同優先度なら投入が早い順(FIFO)。
// far同時上限に達している間はfarのエントリを候補から外す(その分は他が空くまで待つ)。
function _pickQueueIndex(q, farRunning) {
  let best = -1;
  for (let i = 0; i < q.length; i++) {
    const e = q[i];
    if (e.prio === PRIO_RANK.far && farRunning >= FAR_INFLIGHT_MAX) continue;
    if (best < 0 || e.prio < q[best].prio || (e.prio === q[best].prio && e.seq < q[best].seq)) best = i;
  }
  return best;
}
// 空きワーカーがある限り待ち行列から取り出して実行する。
// 【重要】ここは「1件起動 → 自分を再帰呼び出し」で回す。再帰の2周目は直前に更新した
// hostLastStartAtによってペース待ち(MIN_INTERVAL_MS)に引っかかり、タイマー登録して
// 必ず抜けるため無限ループにはならない。
function _pumpHost(host) {
  const q = hostQueues.get(host);
  if (!q || q.length === 0) return;
  const running = hostRunning.get(host) || 0;
  if (running >= UPSTREAM_WORKERS) return;
  const farRunning = hostFarRunning.get(host) || 0;
  const idx = _pickQueueIndex(q, farRunning);
  // 残っているのがfarだけで同時上限に達している場合。farの完了時(下のfinish)か、
  // 新たなblocking/nearの投入時(scheduleUpstream)に再評価されるので、ここでは何もしない。
  if (idx < 0) return;
  const wait = (hostLastStartAt.get(host) || 0) + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) {
    if (!hostPumpTimers.has(host)) {
      hostPumpTimers.set(host, setTimeout(() => { hostPumpTimers.delete(host); _pumpHost(host); }, wait));
    }
    return;
  }
  const e = q.splice(idx, 1)[0];
  hostRunning.set(host, running + 1);
  if (e.prio === PRIO_RANK.far) hostFarRunning.set(host, farRunning + 1);
  hostLastStartAt.set(host, Date.now());
  // 【重要・2026-07-15から継承】task()が永遠に確定しないとワーカーが1本永久に失われる。
  // httpsRequestOnce側のハードタイムアウトで必ず確定することが前提(下記参照)。
  // レーン方式と違い、詰まっても「そのワーカー1本」で被害が止まり、待ち行列の順序は
  // 壊れない(チェーンに積み上がらないため)。
  const finish = () => {
    hostRunning.set(host, Math.max(0, (hostRunning.get(host) || 1) - 1));
    if (e.prio === PRIO_RANK.far) hostFarRunning.set(host, Math.max(0, (hostFarRunning.get(host) || 1) - 1));
    const c = (pendingByHost.get(host) || 1) - 1;
    if (c <= 0) pendingByHost.delete(host); else pendingByHost.set(host, c);
    _pumpHost(host); // 枠が空いたので次を拾う
  };
  Promise.resolve().then(e.task).then(
    (v) => { finish(); e.resolve(v); },
    (err) => { finish(); e.reject(err); }
  );
  _pumpHost(host); // もう1本空いていれば続けて起動(ペース配分は上のwaitで自然に効く)
}
// クライアント(part8.js)がPOSTボディ末尾に付ける優先度ヒント(&priority=blocking|near|far、
// handleApi参照)をそのまま待ち行列の順位に使う。
function scheduleUpstream(host, task, priority) {
  pendingByHost.set(host, (pendingByHost.get(host) || 0) + 1);
  let q = hostQueues.get(host);
  if (!q) { q = []; hostQueues.set(host, q); }
  return new Promise((resolve, reject) => {
    q.push({ prio: PRIO_RANK[priority] != null ? PRIO_RANK[priority] : PRIO_RANK.far, seq: ++_upstreamSeq, task, resolve, reject });
    _pumpHost(host);
  });
}

/* ---------- 上流リクエスト (標準 https、GET/POST両対応、リトライ付き) ---------- */
// 【重要・2026-07-15】以前はhttps.getのみでGET専用だった。Overpassの6タイルまとめクエリは
// URLに埋め込む(GET)と数千文字になり、overpass-api.deから414 (Request-URI Too Long)を
// 返される事象を確認(道路の拡張生成が完全に止まって見えた真因。詳細はpart8.js側コメント参照)。
// POST(ボディにdata=<クエリ>)はURL長に依存しないため、GET/POST両対応に拡張する。
function httpsRequestOnce(urlStr, opts) {
  opts = opts || {};
  // 【2026-07-25・詰まり検出→強制打ち切り対応】通常は45秒(UPSTREAM_TIMEOUT_MS)だが、
  // 呼び出し側(fetchUpstream)がバックログ検出時に短いopts.timeoutMsを渡してきた場合は
  // それを使う。1回のリクエストがレーンを握る最長時間を短縮し、詰まっている時ほど
  // 早く手放させる狙い(詳細はfetchUpstream側コメント参照)。
  const timeoutMs = opts.timeoutMs || UPSTREAM_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, arg) => { if (settled) return; settled = true; clearTimeout(hardTimer); fn(arg); };
    // 【重要】req.setTimeout(下記)はソケットの「無通信」タイムアウトで、上流が細切れにでも
    // データを送り続ける限りリセットされ続け、実測で全体90秒以上pendingのまま(実質無期限)に
    // なるケースが確認された。かつ、レスポンスヘッダ受信後(res確定後)にreq側をdestroyしても
    // resにerrorリスナーが無いとreject/resolveどちらも呼ばれず、このPromiseが永久に解決しない
    // ことがある(scheduleUpstreamのchainsが永久に詰まる直接原因)。通信の活性・不活性に
    // 関わらず必ずどこかで確定させる「ハード上限」を別に設ける。
    const hardTimer = setTimeout(() => {
      req.destroy();
      settle(reject, new Error('upstream hard timeout (' + (timeoutMs + 15000) + 'ms)'));
    }, timeoutMs + 15000);
    const method = opts.method || 'GET';
    const headers = Object.assign({ 'User-Agent': 'chronodrift-proxy/1.0' }, opts.headers || {});
    if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body);
    const req = https.request(urlStr, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => settle(resolve, {
        status: res.statusCode,
        contentType: res.headers['content-type'] || 'application/json',
        body: Buffer.concat(chunks),
      }));
      res.on('error', (e) => settle(reject, e)); // 【重要】これが無いのが上記の主因だった
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('upstream timeout')));
    req.on('error', (e) => settle(reject, e));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// 【2026-07-16】ホスト単位のクールダウン。429/5xx/接続エラーを返したホストは一定時間
// 「不調」として記録し、fetchUpstreamMultiが即スキップして次のミラーへ行けるようにする。
// 以前は毎リクエスト必ず本家(overpass-api.de)から2回試行+バックオフ(計5秒前後)を
// 浪費してからミラーに進む構造で、本家がRenderの共有IPを拒否している間は全リクエストが
// 一律に遅延→クライアント側がプロキシ不調と判断して直接モードへ逃げていた(実機502)。
const hostCooldownUntil = new Map(); // host -> このtimestampまでスキップ
const HOST_COOLDOWN_MS = 45000;
// 【2026-07-27・実測で判明】/api/upstream-status(スロットを消費しない軽量GET)が
// Renderから3ミラーとも失敗した:
//   overpass-api.de        -> AggregateError(全アドレスへの接続試行が失敗)
//   overpass.kumi.systems  -> upstream timeout(8秒間1バイトも来ない)
//   overpass.private.coffee-> upstream timeout
// 軽量GETすら通らないので、これは「スロット枯渇」でも「自己ブロック」でもなく
// 【RenderのegressからOverpassへ到達できない】ネットワークレベルの遮断。
// この状態でプロキシに投げ続けると1タイルあたり45秒×リトライを空費するだけなので、
// (1) 到達不能を素早く確定させ、(2) クライアントへ X-Upstream-Unreachable を返して
// ブラウザ直アクセス(ユーザー自身のIP。実測でOverpassに到達できている)へ倒す。
// 【2026-07-27・撤去】接続レベルの失敗に5分のクールダウンを課していたが、実測で失敗は
// 断続的(38%は成功)と判明したため有害だった。次の1本が成功するかもしれないのに待たせる
// 意味がない。接続失敗はリトライで吸収する(fetchUpstreamのcatch参照)。
const HOST_UNREACHABLE_COOLDOWN_MS = 45000; // 現在はmarkHostCooldownの引数経由でのみ使用(実質未使用)
const hostEverSucceeded = new Set(); // 一度でも応答を受け取れたホスト
const CONN_FAIL_CODES = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|EPIPE|EPROTO|ERR_TLS/;
// 「そのホストへ到達できていない」判定。接続レベルのエラーコード、happy-eyeballsで全アドレス
// 失敗した時のAggregateError(messageが空になることが多い)、および「このプロセスで一度も
// 応答を受け取れていないホストのタイムアウト」を到達不能として扱う。後者を含めるのは、
// ファイアウォールの黙殺(silent drop)は無通信タイムアウトとして現れるため。
// 逆に一度でも成功しているホストのタイムアウトは「上流が重いだけ」なので到達不能にしない。
// 【2026-07-27・実測で判明した自作の罠】当初は「一度も成功していないホストのタイムアウトは
// 到達不能」としていたが、これはプロセス再起動直後に必ず誤爆する。hostEverSucceededは
// プロセス内メモリなのでデプロイ・スピンダウン復帰のたびに空になり、その状態で1本目が
// 密集地の重いクエリでタイムアウトしただけで「到達不能」と断定 → ホスト5分クールダウン＋
// クライアント10分の直接モード、という具合にセッション冒頭で必ず縮退経路へ落ちていた
// (実機で PROXY=0 / DIRECT=4 として観測)。
// タイムアウトは「上流が重い」場合と「経路が死んでいる」場合の両方で起きるので、単発では
// 区別できない。連続して規定回数失敗し、かつ一度も成功していない場合に限って到達不能と
// 見なす。接続レベルのエラー(AggregateError・ECONNREFUSED等)は経路の問題が確定するので
// 従来どおり即断してよい。
const hostTimeoutStreak = new Map(); // host -> 連続タイムアウト回数(現在は診断目的のみ)
function isUnreachableError(e, host) {
  if (!e) return false;
  const msg = String(e.message || '');
  if (e.name === 'AggregateError') return true;
  if (e.code && CONN_FAIL_CODES.test(String(e.code))) return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => x && x.code && CONN_FAIL_CODES.test(String(x.code)))) return true;
  if (CONN_FAIL_CODES.test(msg)) return true;
  // 【2026-07-27・2度目の修正で撤去】当初は「一度も成功していないホストのタイムアウト」を
  // 到達不能と見なし、次に「3連続なら」と緩めたが、それでも誤爆が止まらなかった:
  // 密集地の起動直後は最初の数本が正当にタイムアウトし、かつhostEverSucceededは空のまま
  // (ソフトデッドラインの504は自前生成なので到達の証拠にならない)。結局3ストライクに
  // 到達して直接モードへ落ちる(実機で 504→502→502→direct として観測)。
  // タイムアウトは「上流が重い」と「経路が死んでいる」を原理的に区別できない。本物の遮断は
  // 接続レベルのエラー(AggregateError・ECONNREFUSED等)として現れ、それは上で検出済み
  // なので、タイムアウトを到達不能の材料にするのをやめる。誤って直接モード(縮退経路)へ
  // 落とす代償の方が、遮断の検出が少し遅れる代償より大きい。
  return false;
}
function markHostCooldown(host, unreachable) {
  hostCooldownUntil.set(host, Date.now() + (unreachable ? HOST_UNREACHABLE_COOLDOWN_MS : HOST_COOLDOWN_MS));
}

// 【2026-07-21・マップジャンプ後の詰まり対策】scheduleUpstreamはホストごとに完全直列
// (次のリクエストは前の完了を待ってから開始)なので、密集地(東京等)で長時間過ごして
// 大量のOverpassリクエストがこのキューに積み上がった状態でマップジャンプ(location.reload)
// すると、クライアント側は即座に真っさらな状態から再スタートするが、サーバ側のキューは
// 別プロセス(全プレイヤー共有)なので何も知らず、ジャンプ前の(既にブラウザが切断した)
// リクエストを律儀に1件ずつ最後まで処理(リトライ・タイムアウト込みで数十秒/件)してから
// でないと新しい地域(千葉等)のリクエストに進めない。「高品質モードで東京にいた後
// 千葉へジャンプしたら道路だけ長時間赤のまま」という実機報告と一致する。
// 対策: 各リクエストに紐づくres/reqの接続が切れた(=クライアントがreloadした等で
// もう誰も結果を待っていない)ことを検知したら、そのリクエストの番が回ってきた時点で
// 実際のOverpass呼び出し(1.1秒間隔の直列キューの1枠)をスキップし、即座に次へ進める。
async function fetchUpstream(upstreamUrl, opts) {
  opts = opts || {};
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
  const host = new URL(upstreamUrl).host;
  let lastErr = null;
  let lastRes = null; // 【2026-07-27】実際に受け取った最後のHTTPレスポンス(429/5xx含む)
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.isAbandoned && opts.isAbandoned()) throw new Error('abandoned (no waiters left)');
    try {
      const res = await scheduleUpstream(host, () => {
        // キューで待っている間に依頼主が全員いなくなっていたら、上流への実リクエストは
        // 発行せず即座に諦める(直列キューの1枠・レート制限の待ち時間を浪費しない)。
        if (opts.isAbandoned && opts.isAbandoned()) return Promise.reject(new Error('abandoned (no waiters left)'));
        // 【2026-07-25】このタスクの実際の実行タイミング(レーンの順番が回ってきた瞬間)で
        // 詰まり具合を判定する。呼び出し時点ではなくここで見ることで、キューで待っている
        // 間に詰まりが解消していれば通常の45秒のまま、まだ詰まっていれば短縮版を使う。
        // 【2026-07-25(2)】短縮の度合いはisSoloTile(1タイル単体かどうか)で使い分ける。
        // 1タイル単体は正常時1〜2秒で返るので5秒まで攻めても実害が少ないが、3タイル
        // まとめは正常時でも10〜30秒かかるため、20秒(従来値)より短くすると正常応答まで
        // 打ち切ってリトライを増やし、かえって詰まりを悪化させる。
        // 【2026-07-27・IMPL_PROMPT_20260727 Step A-1】詰まり中でも、プレイヤーが直接
        // 待っているblocking/near優先度のリクエストは短縮タイムアウトの対象から除外する。
        // 詰まり時に率先してこれらを打ち切ると、体感に直結するクエリほど失敗→再試行に
        // 回されてしまい逆効果(詰まりで削るべきは体感に響きにくいfar=まとめクエリ側)。
        const congested = (pendingByHost.get(host) || 0) > CONGESTION_BACKLOG;
        const exemptFromCongestion = opts.priority === 'blocking' || opts.priority === 'near';
        let timeoutMs = (!congested || exemptFromCongestion) ? UPSTREAM_TIMEOUT_MS
          : (opts.isSoloTile ? CONGESTED_TIMEOUT_MS_SOLO : CONGESTED_TIMEOUT_MS_BATCH);
        // 【2026-07-27】フォールバックミラー(fetchUpstreamMultiがidx>0で渡す)は上限を短く
        // 被せる。実績が悪いホストに45秒を差し出さない。
        if (opts.maxTimeoutMs) timeoutMs = Math.min(timeoutMs, opts.maxTimeoutMs);
        return httpsRequestOnce(upstreamUrl, Object.assign({}, opts, { timeoutMs }));
      }, opts.priority); // 【Phase3】blocking/near優先度ヒントをレーン選択まで運ぶ
      hostEverSucceeded.add(host); // HTTPレスポンスが返った=このホストへは到達できている
      hostTimeoutStreak.delete(host); // 連続タイムアウトの計数をリセット
      if (res.status === 200) return res;
      lastErr = new Error('upstream HTTP ' + res.status);
      // 【2026-07-27・実測診断(直接モードが残っていた真因)】以前はここで受け取った
      // 429/5xxのレスポンス自体を捨てて、リトライを使い切ったあと throw lastErr していた。
      // その結果 fetchUpstreamMulti の lastRes も null のままになり、handleApi の catch へ
      // 落ちて【X-Proxy-Healthの付かない502】を返していた。つまり「Overpassが Render の IP を
      // 429でレート制限した」という上流の事情が、クライアントには「プロキシが故障した」
      // として届き、120秒の直接モードに落ちていた(実測: /api/overpass 502 → 直接POSTで
      // 429連発 → 429連続=3)。直接モードに逃げてもレート制限がユーザー自身のIPに移るだけで
      // 何も改善しないため、これは最も避けたい誤誘導。実際に受け取ったレスポンスを保持し、
      // リトライを使い切ったら「上流のステータスそのまま」を返す(=handleApiが中継し、
      // X-Proxy-Health付きで届くのでproxyDownは立たない)。
      lastRes = res;
      if (res.status === 429 || res.status >= 500) {
        markHostCooldown(host);
        log(`  retry ${attempt}/${maxAttempts} (HTTP ${res.status}) ${host}`);
        await sleep(1500 * attempt);
        continue;
      }
      return res; // 4xx 等はそのまま返す
    } catch (e) {
      lastErr = e;
      if (/abandoned/.test(e.message)) throw e; // 諦めた場合はリトライせず即座に抜ける
      // 【2026-07-27】接続レベルの失敗(=そのホストへ到達できない)はリトライしても
      // 同じ結果にしかならず、1回あたり45秒級を空費してタイル取得の予算を食い潰す。
      // 長めのクールダウンを立てて即座に抜け、到達不能フラグを付けて呼び出し元へ返す。
      // 【2026-07-27・実測で方針転換】以前はここで即座に諦めていた(接続レベルの失敗=経路が
      // 死んでいる、という判断)。しかし実機計測で Render→Overpass の接続は【断続的に】
      // 失敗することが分かった: 39本中 成功15 / 接続失敗24(=38%は成功する)。
      // 恒久的な遮断ではないので、諦めるのではなくリトライするのが正しい。接続レベルの
      // 失敗は即座に返る(タイムアウトを待たない)ためリトライのコストがほぼ無く、
      // 3回試せば成功率は 38% -> 約76%(1-0.62^3)まで上がる計算になる。
      // 全試行が接続失敗で終わった時だけ「到達不能」としてクライアントへ伝える。
      if (isUnreachableError(e, host)) {
        e.unreachable = true; // 最終的に投げる時のための印(途中で成功すれば使われない)
        log(`  conn-fail ${attempt}/${maxAttempts} ${host} (${e.name}${e.message ? ': ' + e.message : ''})`);
        // 接続失敗は即座に返るので待ちは短くてよい(タイムアウト系の1.5秒×attemptより短く)
        await sleep(300 * attempt);
        continue;
      }
      markHostCooldown(host);
      log(`  retry ${attempt}/${maxAttempts} (${e.message}) ${host}`);
      await sleep(1500 * attempt);
    }
  }
  // 【2026-07-27】HTTPレスポンス自体は受け取れていた(429/5xx)なら、それを返す。
  // throwにすると呼び出し元でステータスが失われ、handleApiが「プロキシ故障」を意味する
  // ヘッダ無し502を返してしまい、クライアントを直接モードへ誤誘導する(上のコメント参照)。
  // レスポンスを1度も受け取れなかった場合(接続不能・タイムアウト等)だけthrowする。
  if (lastRes) return lastRes;
  throw lastErr;
}

// 複数ミラー対応版: 先頭(本命)ミラーから順に試し、どれかが200を返したら採用。
// 全滅した場合は最後に得られたレスポンス(あれば)かエラーを返す。
// 各ミラーは独立ホストなので scheduleUpstream のレート制限キューも別々になり、
// 一方のホストが混雑/拒否していてももう一方には影響しない。
// 【2026-07-19】以前は全ミラーとも一律maxAttempts:2で試していたが、実機ログで
// kumi.systems/private.coffeeが「毎回」タイムアウト(45秒×2回=90秒超/ミラー)することが
// 判明し、本命(先頭)に辿り着く前にリクエスト全体が数分〜十数分単位で遅延する原因になって
// いた。2番目以降(フォールバック)のミラーは1回だけ試して見切りをつけ、生きている
// 可能性が高い先頭ミラーへ早く戻れるようにする。
// 【2026-07-27・重大な罠の修正】以前はクールダウン中のホストを一律で候補から外していたが、
// markHostCooldownは429/5xx/タイムアウト/詰まり時の短縮打ち切りの「全部」で発火し45秒続く。
// つまり本家(overpass-api.de)が1回504を返しただけで、45秒間はこのフィルタが本家を候補から
// 削除し、上のコメント自身が「毎回タイムアウトする」と明記しているkumi/private.coffeeが
// 先頭(=maxAttempts:2)に昇格していた。1リクエストで最悪 60秒×2 + 60秒 ≒ 3分を溶かし、
// その間クライアントは28秒でabort→失敗→バックオフ、という「本家が生きていても全滅」状態に
// なる。先頭(本命)ミラーはクールダウン中でも必ず先頭に残し、フィルタは2番目以降にだけ
// 適用する(=「本家がダメな時に代わりを試す」という本来の意図に戻す)。
async function fetchUpstreamMulti(upstreamUrls, opts) {
  let lastRes = null, lastErr = null;
  const _now = Date.now();
  const primary = upstreamUrls[0];
  const rest = upstreamUrls.slice(1).filter((u) => (hostCooldownUntil.get(new URL(u).host) || 0) < _now);
  upstreamUrls = [primary].concat(rest);
  // 【2026-07-27・撤去】ここには「全ミラーがクールダウン中なら即座に到達不能を返す」早期
  // リターンがあったが、2つの意味で誤りだった。
  //  (1) hostCooldownUntil は markHostCooldown(host) が【タイムアウト・5xx・429の全部】で
  //      立てる45秒の汎用クールダウンで、「到達不能」の証拠ではない。上のrestフィルタで
  //      非プライマリは既に除外されるため、この every は実質「プライマリが冷えているか」の
  //      1条件になり、overpass-api.deが1回タイムアウトしただけで e.unreachable が立ち、
  //      X-Upstream-Unreachable 経由でクライアントが10分間DIRECTへ落ちていた
  //      (実機の 504→502→502→direct と一致)。isUnreachableErrorからタイムアウトを
  //      外してもこの経路は残る。
  //  (2) そもそも「先頭(本命)ミラーはクールダウン中でも必ず先頭に残して試す」という直前の
  //      修正と矛盾している。候補に残しながら試す前に打ち切っていた。
  // 仮にフラグだけ外しても、45秒のクールダウン中は全リクエストが即502で失敗し、密集地では
  // プライマリが常時冷えて「DIRECTには落ちないが何も取れない」停滞に変わるだけなので、
  // 早期リターンごと撤去する。本物の遮断(接続レベルのエラー)は下のcatchで
  // isUnreachableErrorが捉え、そちらは即座に短絡するので粘りすぎることもない。
  for (let idx = 0; idx < upstreamUrls.length; idx++) {
    if (opts && opts.isAbandoned && opts.isAbandoned()) throw new Error('abandoned (no waiters left)');
    const url = upstreamUrls[idx];
    try {
      // フォールバックミラーは実績が悪い(毎回タイムアウト)ため、1回だけ・かつ短い持ち時間で
      // 見切る。死んでいる場合の損失を45秒×3から10秒程度に抑え、本家の再試行へ早く戻す。
      // 【2026-07-27】接続失敗のリトライを4回に増やしたが実測で成功率は上がらず
      // (38%->24%)、失敗が時間的に相関していることが判明したため2回に戻した。
      const res = await fetchUpstream(url, Object.assign({}, opts, { maxAttempts: idx === 0 ? 2 : 1, maxTimeoutMs: idx === 0 ? null : 10000 }));
      if (res.status === 200) return res;
      lastRes = res;
    } catch (e) {
      lastErr = e;
      // 依頼主が全員いなくなった場合は他のミラーを試さず即座に諦める(無駄な待ちを増やさない)
      if (/abandoned/.test(e.message)) throw e;
      log(`  mirror failed (${e.message}), trying next if available`);
    }
  }
  if (lastRes) return lastRes;
  throw lastErr || new Error('all overpass mirrors failed');
}

// POSTボディの読み取り(Overpassクエリ用。GET系API(elevation/nominatim)では未使用)
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------- プロキシ本体 (キャッシュ + 同時リクエスト合流) ---------- */
const inflight = new Map();
// 【2026-07-21・マップジャンプ後の詰まり対策】cacheKeySourceごとに「まだ結果を待っている
// クライアント接続の数」を数える。同じキーへ複数プレイヤーが同時にアクセスしている間は
// 1以上を維持し(inflightのdedup合流と同じ単位)、全員が切断(reload等)したら0に戻る。
// fetchUpstream/fetchUpstreamMultiはこれを見て、自分の番が回ってきた時点で誰も待っていな
// ければ上流呼び出し自体を省略する(scheduleUpstreamの直列キューを無駄に占有しない)。
const inflightWaiters = new Map();

async function handleApi(req, res, apiKey) {
  const api = APIS[apiKey];
  const rest = req.url.slice(apiKey.length); // 例: "/v1/srtm30m?locations=..." / GET系の "?data=..."
  // 【重要・2026-07-15】Overpassの6タイルまとめクエリはGETでURLに埋め込むと414
  // (Request-URI Too Long)を上流から返される規模になるため、クライアント側(part8.js)は
  // POST(ボディにdata=<クエリ>)へ切り替えた。ここではPOSTならボディを読み取り、
  // それをそのまま上流へもPOSTで転送する。キャッシュキーもURL(restは空になる)ではなく
  // ボディ内容ベースに切り替える必要がある。
  const rawBody = req.method === 'POST' ? await readRequestBody(req) : '';
  // 【2026-07-26・IMPL_PROMPT_20260724 Phase3】クライアント(part8.js)が付ける優先度ヒント。
  // blocking(現在地タイル)/near(近傍分離ジョブ・近傍単体クエリ)/far(それ以外)の3値。
  // カスタムヘッダ(X-Tile-Priority等)ではなくPOSTボディ末尾の"&priority=..."として送る
  // (カスタムヘッダを付けると、直接モード[プロキシ不健全時、ブラウザ→overpass-api.deへの
  // 本物のクロスオリジンリクエスト]でCORSプリフライトが発生し、Overpassが応答しなければ
  // リクエストごと失敗しかねない。ボディに追加フィールドを足すだけなら「シンプル
  // リクエスト」のままなのでCORS問題を起こさない)。上流(Overpass本体)・キャッシュキー
  // ともにこのフィールドを一切知らなくてよいので、ここで検出・除去してから使う。
  const _pMatch = rawBody.match(/&priority=(blocking|near|far)$/);
  const priority = _pMatch ? _pMatch[1] : 'far'; // 想定外(ヘッダ無し・古いクライアント等)は安全側でfar
  const reqBody = _pMatch ? rawBody.slice(0, _pMatch.index) : rawBody;
  const upstreamUrl = api.upstream + rest;
  const cacheKeySource = reqBody ? (upstreamUrl + '|POST|' + reqBody) : upstreamUrl;
  const file = cachePath(api.dir, cacheKeySource);
  const isAbandoned = () => (inflightWaiters.get(cacheKeySource) || 0) <= 0;
  // 【2026-07-25(2)】クエリ本文が自己申告しているOverpass側timeout([timeout:N])を見て、
  // 1タイル単体クエリか複数タイルまとめクエリかを判定する(詰まり時のタイムアウト長さの
  // 使い分けに使う。詳細はCONGESTED_TIMEOUT_MS_SOLO/BATCH宣言部のコメント参照)。
  let isSoloTile = false;
  if (reqBody) {
    try {
      const m = decodeURIComponent(reqBody).match(/\[timeout:(\d+)\]/);
      if (m) isSoloTile = parseInt(m[1], 10) <= SOLO_QUERY_TIMEOUT_SEC_MAX;
    } catch (e) { /* デコード失敗時はbatch扱いのまま(安全側) */ }
  }
  const upstreamOpts = Object.assign(
    reqBody
      ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: reqBody }
      : {},
    { isAbandoned, isSoloTile, priority }
  );

  // 1) キャッシュヒット → 即応答
  // 【2026-07-26・Phase4】期限切れなら例外を投げてmiss扱いに落とす(下の(2)で上書き取得)。
  try {
    const cached = JSON.parse(await fsp.readFile(file, 'utf8'));
    const ttlMs = CACHE_TTL_MS_BY_DIR[api.dir];
    const cachedAtMs = Date.parse(cached.cachedAt);
    if (ttlMs && Number.isFinite(cachedAtMs) && (Date.now() - cachedAtMs) > ttlMs) {
      throw new Error('cache expired');
    }
    res.writeHead(200, { 'Content-Type': cached.contentType, 'X-Cache': 'HIT', 'X-Proxy-Health': 'ok' });
    res.end(cached.body);
    log(`HIT  ${apiKey} ${(reqBody || rest).slice(0, 60)}...`);
    return;
  } catch (_) { /* miss (期限切れ含む) */ }

  // このリクエストを「待ち人数」として登録する(同一キーへの合流分もそれぞれ+1する)。
  // reqの接続が切れたら(ブラウザのreload・タブ閉じ等)必ず1つ減らす。
  inflightWaiters.set(cacheKeySource, (inflightWaiters.get(cacheKeySource) || 0) + 1);
  let _waiterRemoved = false;
  const removeWaiter = () => {
    if (_waiterRemoved) return;
    _waiterRemoved = true;
    const n = (inflightWaiters.get(cacheKeySource) || 1) - 1;
    if (n <= 0) inflightWaiters.delete(cacheKeySource); else inflightWaiters.set(cacheKeySource, n);
  };
  // 【2026-07-27・実測で判明した不具合】以前は req.on('close', removeWaiter) だった。
  // これはNode 16以降では機能しない: IncomingMessageの'close'は「接続が切れた時」ではなく
  // 「リクエストの読み取りが完了した時」に発火する仕様に変わっており、POSTでは
  // readRequestBody(この関数の冒頭)が本文を読み切った時点で既に発火し req.destroyed=true に
  // なっている。その後(ここ)でリスナを張っても二度と呼ばれない。
  // Node v22で実測確認: 本文読み切り後は req.destroyed=true / readableEnded=true で、
  // クライアントがabortしても req の'close'は発火しない。
  // 影響は2つ:
  //  (1) inflightWaitersが減らず単調増加する(メモリリーク)
  //  (2) isAbandoned()が永久にfalseのまま = マップジャンプ・クライアントabort後の
  //      「もう誰も待っていないリクエストを上流に投げない」最適化(2026-07-21実装)が
  //      POST経路では一度も動いていなかった。無駄なOverpassスロット消費が出続けていた。
  // 正しい検知先はres(ServerResponse)の'close'。実測: 応答を待っている間は未発火、
  // クライアントがabortした瞬間(1005ms)に発火する。応答を返し終えた時にも発火するが、
  // その時はもう待ち人数の意味がないので害はない。
  res.on('close', removeWaiter);

  // 2) ミス → 上流 (同一キーの同時リクエストは1本に合流)
  let p = inflight.get(cacheKeySource);
  if (!p) {
    p = (async () => {
      const t0 = Date.now();
      const up = api.mirrors
        ? await fetchUpstreamMulti(api.mirrors.map((m) => m + rest), upstreamOpts) // 先頭(private.coffee)優先
        : await fetchUpstream(upstreamUrl, upstreamOpts);
      log(`MISS ${apiKey} -> upstream ${up.status} (${Date.now() - t0}ms)`);
      if (up.status === 200) {
        const bodyStr = up.body.toString('utf8');
        let parsed;
        try { parsed = JSON.parse(bodyStr); } catch (e) { throw new Error('upstream returned non-JSON'); }
        // 【重要・2026-07-16】Overpassはエラーもremarkも出さずに部分応答を200で返すことが
        // ある(無言の部分応答)。従来は200+有効JSONなら無条件で永久キャッシュしていたため、
        // 一度部分応答を掴むと以降の再試行が全てHITで同じ欠損データを返し続けていた
        // (「リロードしても二度と埋まらない空き地」の一因)。クライアント(part8.js)が
        // クエリに入れるout count;の宣言総数と実受信数を照合し、不完全な応答は
        // キャッシュせずそのまま返す(クライアント側の同じ検証が失敗→再試行し、
        // 次回はキャッシュ未汚染のまま上流に再問い合わせできる)。
        let cacheable = true;
        if (api.dir === 'overpass' && parsed && Array.isArray(parsed.elements)) {
          if (parsed.remark && /timed out|timeout|out of memory/i.test(parsed.remark)) cacheable = false;
          const countEl = parsed.elements.find((el) => el.type === 'count');
          if (countEl) {
            const declared = parseInt(countEl.tags && countEl.tags.total, 10);
            const received = parsed.elements.filter((el) => el.type !== 'count').length;
            if (!Number.isFinite(declared) || received < declared) cacheable = false;
          } else if (/out[+%20]{1,3}count/i.test(reqBody)) {
            cacheable = false; // count要素を要求したのに無い=出力先頭から切り捨てられている
          }
        }
        if (cacheable) {
          await fsp.mkdir(path.dirname(file), { recursive: true });
          const tmp = file + '.tmp';
          await fsp.writeFile(tmp, JSON.stringify({ url: upstreamUrl, cachedAt: new Date().toISOString(), contentType: up.contentType, body: bodyStr }));
          await fsp.rename(tmp, file);
        } else {
          log(`SKIP-CACHE ${apiKey} incomplete overpass response`);
        }
        return { status: 200, contentType: up.contentType, body: bodyStr };
      }
      return { status: up.status, contentType: up.contentType, body: up.body.toString('utf8') };
    })();
    inflight.set(cacheKeySource, p);
    const cleanup = () => inflight.delete(cacheKeySource);
    p.then(cleanup, cleanup);
  }

  try {
    // 【2026-07-27・Render 502の回避】上流のリトライ・ミラー巡回を全部足すと1リクエストが
    // 100秒を超えることがあり、その場合Renderのエッジ側がクライアントへ502を返してしまう
    // (=プロキシ自身は正常に動いているのに、クライアントからは「プロキシが落ちた」に見え、
    // 上のINJECT側でproxyDown→120秒の直接モードに落ちる引き金になっていた)。
    // Renderに殺される前に自分の判断で見切りをつけ、「上流が間に合わなかった」ことを
    // 504として、かつX-Proxy-Health付き(=プロキシは健全)で返す。
    // 進行中のp(inflight)は打ち切らずそのまま走らせ続ける: 完了すればディスクキャッシュに
    // 入るので、クライアントの次の再試行がHITで即座に取れる(既存のinflight設計と同じ狙い)。
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({
        status: 504, contentType: 'application/json',
        body: JSON.stringify({ error: 'proxy_deadline', message: 'upstream still running; retry to pick up the cached result' }),
      }), PROXY_SOFT_DEADLINE_MS);
    });
    const out = await Promise.race([p, deadline]);
    clearTimeout(timer);
    res.writeHead(out.status, { 'Content-Type': out.contentType, 'X-Cache': 'MISS', 'X-Proxy-Health': 'ok' });
    res.end(out.body);
  } catch (e) {
    // ここに来るのは「上流からHTTPレスポンスを1度も受け取れなかった」場合だけ
    // (429/5xxを受け取れていたなら上のfetchUpstreamがそれを返すので中継される)。
    // 【2026-07-27】さらに2つを区別する:
    //  (a) 接続そのものが張れない(DNS不能・接続拒否・切断)= Renderのネットワーク経路から
            //      上流に到達できない。この場合はブラウザ直接アクセスの方が通る可能性があり、
    //      直接モードへの退避に意味がある(このフォールバックが作られた本来の動機)。
    //      → X-Upstream-Unreachable を付け、INJECT側で直接モードへ倒すことを許す。
    //  (b) タイムアウト(上流が重い・混雑)= 密集地では日常的に起きる。直接モードに逃げても
    //      ユーザー自身のIPで同じ重いクエリを投げるだけで改善せず、429を誘発するだけ。
    //      → X-Proxy-Health のみ付け、直接モードには落とさない(タイル別backoffに任せる)。
    // 【2026-07-27】判定は isUnreachableError に一元化(AggregateError・e.code・e.errors・
    // 「一度も成功していないホストのタイムアウト」まで拾う。以前の単純なmessage正規表現は
    // 実測のAggregateError(messageが空)を取りこぼしていた)。
    const unreachable = !!(e && e.unreachable) || isUnreachableError(e, null);
    log(`FAIL ${apiKey}: ${e.message}${unreachable ? ' [unreachable]' : ' [slow/timeout]'}`);
    const headers = { 'Content-Type': 'application/json', 'X-Cache': 'MISS', 'X-Proxy-Health': 'ok' };
    if (unreachable) headers['X-Upstream-Unreachable'] = '1';
    res.writeHead(502, headers);
    res.end(JSON.stringify({ error: 'proxy_failed', message: e.message, unreachable }));
  }
}

/* ---------- 静的ファイル配信 ---------- */
async function handleStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }

  let data;
  try {
    data = await fsp.readFile(filePath);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  // index.html にはプロキシ用スクリプトを注入して配信 (ファイル自体は無変更)
  if (path.basename(filePath) === 'index.html') {
    let html = data.toString('utf8');
    const injected = DEPLOY_INFO_SCRIPT + '\n' + INJECT;
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + '\n' + injected);
    else html = injected + html;
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(html);
    return;
  }

  // 【2026-07-20】js/legacy/*.js等の静的ファイルにCache-Controlが一切付いておらず、
  // ブラウザのヒューリスティックキャッシュに任せきりだった。頻繁に修正・デプロイする
  // 開発中のゲームでこれをやると、サーバー側は最新でもプレイヤーのブラウザが古いJSを
  // キャッシュしたまま「直したはずのバグが直っていない」という報告が起き得る
  // (index.htmlだけ既にno-cacheだったが、実体のロジックはjs/legacy側にあるため無意味だった)。
  // index.htmlと同じくno-cacheにして、更新のたびブラウザに確実に反映させる。
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  res.end(data);
}

/* ---------- サーバ ---------- */
const server = http.createServer((req, res) => {
  // 【2026-07-27・診断用】Renderの「サーバー自身のIP」から見たOverpassのスロット状況と、
  // このプロセス内のスケジューラ状態をまとめて返す読み取り専用エンドポイント。
  // 実測で /api/overpass の失敗が全て "upstream timeout"(ソケット無通信タイムアウト)だと
  // 判明したが、これはOverpassが「スロットが空くまで無言で接続を保持する」挙動と一致する。
  // つまり原因は「RenderのIPに割り当てられるスロットが空いていない」可能性が高い。ただし
  // それが (a) Renderの共有IPが他利用者と競合して恒常的に枯れている のか
  //        (b) 自分のワーカー2本+見捨てられた古いリクエストが自分で2スロットを埋めている のか
  // はクライアント側からは区別できない(ブラウザの/api/statusはユーザー自身のIPを見るため)。
  // /api/statusはスロット消費対象外の軽量エンドポイントなので、ここから直接叩いてよい
  // (scheduleUpstreamを通さない=レーンもペーシングも消費しない)。
  // 【2026-07-27・コールドスタート対策】上流に一切触らない極軽量の生存確認。
  // Render無料プランは15分無アクセスでスピンダウンし、復帰に実測39秒かかる。その間
  // Renderのエッジは "Application loading" のHTML(5xx)を返すため、INJECT側の
  // 「X-Proxy-Health の無い5xx = プロキシ故障」判定に合致してproxyDownがラッチし、
  // セッション丸ごとDIRECT(縮退経路)で走っていた。クライアントはまずここを叩いて
  // 200が返るまでタイル取得を保留する。プロセスが応答できている＝この応答が返せる、なので
  // 判定として過不足がない。
  if (req.url === '/api/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Proxy-Health': 'ok' });
    res.end(JSON.stringify({ ok: true, uptimeSec: Math.round(process.uptime()), deploy: DEPLOY_COMMIT }));
    return;
  }
  if (req.url === '/api/upstream-status') {
    (async () => {
      const out = { deploy: { time: DEPLOY_TIME.toISOString(), commit: DEPLOY_COMMIT }, scheduler: {}, upstream: {} };
      for (const [host, n] of pendingByHost) out.scheduler[host] = {
        pending: n, // 待ち行列+実行中
        running: hostRunning.get(host) || 0,
        farRunning: hostFarRunning.get(host) || 0,
        queue: (hostQueues.get(host) || []).reduce((a, e) => {
          const k = ['blocking', 'near', 'far'][e.prio]; a[k] = (a[k] || 0) + 1; return a;
        }, {}),
      };
      out.scheduler.inflightKeys = inflight.size;
      out.scheduler.inflightWaiters = inflightWaiters.size;
      out.scheduler.hostCooldown = [...hostCooldownUntil].map(([h, t]) => h + ':' + Math.max(0, Math.round((t - Date.now()) / 1000)) + 's');
      for (const m of OVERPASS_MIRRORS) {
        const h = new URL(m).host;
        try {
          const r = await httpsRequestOnce('https://' + h + '/api/status', { timeoutMs: 8000 });
          // 【2026-07-27】この軽量GETが通った=そのホストへ到達できている、という事実は
          // isUnreachableErrorの判定材料として有効なので記録する(以前はfetchUpstream経由の
          // 成功しか記録しておらず、診断エンドポイントの成功が活かされていなかった)。
          hostEverSucceeded.add(h);
          hostTimeoutStreak.delete(h);
          out.upstream[h] = { status: r.status, body: r.body.toString('utf8').slice(0, 500) };
        } catch (e) { out.upstream[h] = { error: (e && e.message) || String(e) }; }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out, null, 2));
    })().catch((e) => { try { res.writeHead(500); res.end(String(e && e.message)); } catch (_) {} });
    return;
  }
  const apiKey = Object.keys(APIS).find((k) => req.url === k || req.url.startsWith(k + '/') || req.url.startsWith(k + '?'));
  // 【2026-07-27】ここの500はhandleApi自身が例外で落ちた場合の最後の受け皿。以前はヘッダを
  // 一切付けていなかったため、INJECT側の判定(X-Proxy-Healthが無い5xx = プロキシ故障)で
  // 120秒の直接モードに落ちる引き金になっていた。handleApiの中でresを返せた=プロセスは
  // 生きているので、X-Proxy-Healthを付けて「上流の問題」として扱わせる(直接モードにしない)。
  if (apiKey) {
    handleApi(req, res, apiKey).catch((e) => {
      try {
        log(`HANDLER-FAIL ${apiKey}: ${(e && e.message) || e}`);
        res.writeHead(500, { 'Content-Type': 'application/json', 'X-Proxy-Health': 'ok' });
        res.end(JSON.stringify({ error: 'handler_failed' }));
      } catch (_) {}
    });
    return;
  }
  handleStatic(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch (_) {} });
});

server.listen(PORT, HOST, () => {
  console.log('ChronoDrift server (proxy + cache)');
  console.log(`  game root : ${ROOT}`);
  console.log(`  cache dir : ${CACHE_DIR}`);
  console.log(`  listening : http://localhost:${PORT}/  (LAN: http://<このPCのIP>:${PORT}/)`);
});
