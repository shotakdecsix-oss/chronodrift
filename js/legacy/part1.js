/**
 * legacy/part1.js — index.html の巨大インラインスクリプトを、挙動を変えずに
 * 行範囲のまま機械的に切り出した最初のファイル(1/9)。
 * ロジックの再編・命名整理は行っていない。読み込み順は元のコードと同一を維持する必要がある
 * (classic scriptなのでグローバルスコープを共有し、宣言順に依存しているため)。
 */
// ======= UI言語(日本語⇔English)切替 =======
// 【2026-07-22】設定パネルからUI言語を切り替えられるようにする(ユーザー要望)。
// classic script(モジュールバンドラ不使用)で index.html の <script> タグ順に
// 全part.jsがグローバルスコープを共有しているため、辞書・t()・setLang()・applyI18n()は
// 最初に読み込まれるこのファイルの冒頭で定義し、他の全part.jsから素朴に参照できるようにする。
// 絵文字は言語に関わらず視認性のため残す(辞書の値自体に絵文字を含めて持つ)。
const I18N = {
  ja: {
    // ---- 静的UI(index.html) ----
    addrLoading: '📍 現在地を取得中...',
    addrUnknown: '📍 (住所不明)',
    gpsLoading: '📍 座標取得中...',
    viewBtnTitle: '視点切替(三人称→一人称→上空)',
    viewThird: '👁 三人称',
    viewFirst: '👁 一人称',
    viewTop: '🗺 上空',
    jumpBtnTitle: 'マップジャンプ',
    modeBtnTitle: '時代モード',
    modeReal: '🏙 現実',
    modeMeiji: '🌾 明治',
    modeEdo: '🏯 江戸',
    modeMarchen: '🍭 メルヘン',
    modeSpace: '🛸 宇宙',
    perfBtnTitle: '設定(描写・海面・時間帯・キャラクター・視点)',
    helpBtnTitle: '操作ヘルプ',
    perfSectionTitle: '⚙ 描写範囲・負荷(変更すると再読み込みします)',
    perfLite: '🌱 軽量',
    perfStd: '⚖️ 標準',
    perfHigh: '🏙 高品質',
    perfLiteSub: '軽量',
    perfStdSub: '標準',
    perfHighSub: '高品質',
    perfDesc1: '軽量: 建物1.4km/低負荷(スマホ向け)<br>標準: 建物2.2km<br>高品質: 建物4.2km/先読み拡大(高性能PC向け・メモリ大)',
    cleanupNowBtn: '🧹 今すぐ整理',
    cleanupDesc: '現在地周辺以外の道路・建物・公園/水面等のGPUメッシュを解放します(記録は残るので再訪すれば元通り。長時間プレイで重くなってきたら押してください)',
    debugTileBtn: '🩺 タイル状況',
    debugTileDesc: 'デバッグ用: 周囲のOSMタイルごとの取得・生成状況を色分け表示します(灰=未取得 赤=取得中 青=地形待ち 橙=生成中 緑=完了)',
    hardResetBtn: '🔄 データを全消去して再読込',
    hardResetDesc: '読み込み・生成が滞って直らない時用: 保持している地形・道路・線路・建物データとキャッシュを全て消去し、現在地のまま再読み込みします(今すぐ整理より強力ですが、再読み込みが発生します)',
    hardResetConfirm: '地形・道路・建物のデータとキャッシュを全て消去して再読み込みします。よろしいですか？',
    hardResetProgress: '消去中…',
    timeSectionTitle: '🕐 時間帯(手動固定)',
    timeAuto: '🕐 自動',
    timeMorning: '🌅 朝',
    timeNoon: '☀️ 昼',
    timeEvening: '🌇 夕',
    timeNight: '🌙 夜',
    timeAutoSub: '自動',
    timeMorningSub: '朝',
    timeNoonSub: '昼',
    timeEveningSub: '夕',
    timeNightSub: '夜',
    timeDesc: '昼に固定して建物の色を確認できます(紫っぽく見える場合の切り分けに)',
    charSectionTitle: '🧍 キャラクター',
    charBoy: '👦 少年',
    charGirl: '👧 少女',
    camDirSectionTitle: '🔄 視点回転の向き',
    camDirStandard: '標準',
    camDirInverted: '反転',
    uiToggleTitle: 'UI表示/非表示',
    mapHintDefault: 'タップした場所にジャンプします',
    mapSearchPlaceholder: '地名・住所・施設名で検索',
    mapSearchBtnLabel: '🔎 検索',
    geoBtnLabel: '📡 現在地',
    jumpHistorySummary: '🕘 履歴',
    helpBody: 'PC: WASD移動 / Shiftダッシュ / Spaceジャンプ / ドラッグ回転 / Cで高度キープ切替 / Bで🐦BIRDモード切替(浮遊・3倍速、Space上昇/Ctrl下降)<br>スマホ: 左スティック移動(倒すほど加速) / 右スワイプ回転 / ⤴ジャンプ / 🔓で高度キープ切替 / 🐦でBIRDモード切替(⤴上昇/⤵下降)',
    closeBtn: '閉じる',
    statusInitial: '🗺 伊勢原マップ読み込み中...',
    debugLegendHtml: '🩺左から地形/道路線路/建物の3本<span style="background:#555555"></span>未取得<span style="background:#3388dd"></span>待ち<span style="background:#dd3333"></span>取得中<span style="background:#ffaa22"></span>生成中<span style="background:#33cc55"></span>完了<span style="background:#9b3fd4"></span>諦め(未着)',
    altKeepTitleOff: '高度キープ(空中でタップ)',
    altKeepTitleOn: '高度キープ中(タップで解除)',
    birdBtnTitleOff: 'BIRDモード(浮遊・3倍速)',
    birdBtnTitleOn: 'BIRDモード中(タップで解除)',
    birdDownBtnTitle: '下降(BIRDモード中)',
    // ---- 動的メッセージ(part4/6/7/8.js) ----
    mapHintJumpTo: '📍 {name} へジャンプ！',
    mapHintSearching: '🔎 「{q}」を検索中...',
    mapHintNotFound: '⚠️ 「{q}」が見つかりませんでした',
    mapHintGeoUnsupported: '⚠️ この端末・ブラウザは位置情報に対応していません',
    mapHintGeoHttpsOnly: '⚠️ 位置情報はHTTPS接続でのみ使えます(http://192.168.…などLAN経由では不可。Render等のhttps版でお試しを)',
    mapHintGeoFetching: '📡 現在地を取得中...',
    mapHintGeoJump: '📍 現在地へジャンプ！',
    mapHintGeoFailed: '⚠️ 現在地を取得できませんでした({reason})',
    geoPermissionDenied: '位置情報の利用が許可されていません',
    // 【2026-07-27・GPS追従モード(モードA)】現在地ボタンをトグル化した際の追加文言
    geoBtnTitleOff: 'GPS追従開始(実際に歩くとゲーム内も追従します)',
    geoBtnTitleOn: 'GPS追従中(タップで解除)',
    // 【2026-07-27】背景色の変化だけでは分かりにくいとのユーザー報告のため、
    // 追従中はボタンの文字自体も変える(altKeepBtn等と同じ「状態で表示を差し替える」方式)。
    geoBtnLabelActive: '🛰 追従中',
    geoFollowBadgeLabel: '🛰 GPS追従中',
    geoFollowBadgeTitle: 'タップで解除',
    mapHintGeoTracking: '📡 GPS追従中(現在地ボタンでいつでも解除できます)',
    mapHintGeoStopped: '📡 GPS追従を解除しました',
    mapHintGeoBlocked: '⚠️ このサイトで位置情報がブロックされています。ブラウザのアドレスバー付近の🔒(サイト情報)アイコン→位置情報の設定を「許可」に変更してから、もう一度お試しください',
    mapHintGeoTimeout: '⚠️ 位置情報の取得がタイムアウトしました。iPhoneの「設定→プライバシーとセキュリティ→位置情報サービス」がON、「設定→Chrome→位置情報」が「次回または共有時に確認」になっているか確認し、それでも直らなければアプリを完全に閉じて開き直してください',
    gpsElevation: '標高 {elev}m',
    gpsOpenGoogleMaps: 'Googleマップで開く',
    meijiLanduseLabel: '明治期土地利用',
    meijiLanduseEdoLabel: '明治期データを江戸期の近似として',
    meijiLoadingToast: '{label}データ取得中...',
    meijiLoadedToast: '{label} {count} 地点読込',
    terrainLoadingRegion: '🏔 この地域の地形を取得中...',
    terrainApplied: '🏔 地形反映完了',
    terrainFarFailRetry: '⚠️ 遠景の地形取得に失敗しています(自動で再試行中)',
    terrainFarGiveUp: '⚠️ 遠景データを取得できません(平坦な遠景のまま続行します)',
    mapLoadingToast: '🗺 マップを読み込み中...',
    cleanupDoneToast: '🧹 現在地周辺以外を整理しました(ジオメトリ {before} → {after})',
    mapShownToast: '✨ マップを表示しました',
    mapPartialFailToast: '⚠️ 地図取得が一部失敗しました(背景で再試行を続けます)',
    meijiCreditBase: '明治期土地利用: 出典 <a href="https://habs.rad.naro.go.jp/" target="_blank" style="color:#cdb">農研機構農業環境研究部門</a>(迅速測図・CC BY 4.0)',
    meijiCreditEdoNote: '<br>※江戸期の実測地図が無いため、明治期データを近似として使用しています',
    edoRealDataCredit: '<br>江戸期街道・町家領域: 出典 <a href="https://codh.rois.ac.jp/historical-gis/" target="_blank" style="color:#cdb">ROIS-DS人文学オープンデータ共同利用センター</a>「江戸主要街道データセット」「『江戸切絵図』町家領域データセット」・<a href="https://rekichizu.jp/" target="_blank" style="color:#cdb">れきちず</a>(いずれもCC BY 4.0)',
    deployInfoUnavailable: 'デプロイ日時: 取得できません(サーバ経由で開いてください)',
    deployInfoLine: '🚀 デプロイ日時: {time}',
    deployInfoCommitSuffix: ', コミット: {time}',
  },
  en: {
    // ---- 静的UI(index.html) ----
    addrLoading: '📍 Locating you...',
    addrUnknown: '📍 (Unknown location)',
    gpsLoading: '📍 Fetching coordinates...',
    viewBtnTitle: 'Switch view (3rd person to 1st person to top-down)',
    viewThird: '👁 3rd Person',
    viewFirst: '👁 1st Person',
    viewTop: '🗺 Top-down',
    jumpBtnTitle: 'Map jump',
    modeBtnTitle: 'Era mode',
    modeReal: '🏙 Real',
    modeMeiji: '🌾 Meiji',
    modeEdo: '🏯 Edo',
    modeMarchen: '🍭 Fairytale',
    modeSpace: '🛸 Space',
    perfBtnTitle: 'Settings (rendering, sea level, time of day, character, view)',
    helpBtnTitle: 'Controls help',
    perfSectionTitle: '⚙ Render distance & load (changing this reloads the page)',
    perfLite: '🌱 Light',
    perfStd: '⚖️ Standard',
    perfHigh: '🏙 High Quality',
    perfLiteSub: 'Light',
    perfStdSub: 'Standard',
    perfHighSub: 'High Quality',
    perfDesc1: 'Light: buildings 1.4km / low load (for phones)<br>Standard: buildings 2.2km<br>High Quality: buildings 4.2km / wider prefetch (for powerful PCs, uses more memory)',
    cleanupNowBtn: '🧹 Clean up now',
    cleanupDesc: 'Frees up GPU meshes for roads/buildings/parks/water away from your current location (records are kept, so revisiting restores them. Press this if things get heavy after a long play session)',
    debugTileBtn: '🩺 Tile status',
    debugTileDesc: 'Debug: color-codes the fetch/generation status of nearby OSM tiles (gray=not fetched, red=fetching, blue=waiting for terrain, orange=generating, green=done)',
    hardResetBtn: '🔄 Clear all data & reload',
    hardResetDesc: 'Use when loading/generation is stuck and won\'t recover: clears all stored terrain/road/rail/building data and the cache, then reloads at your current location (stronger than Clean up now, but triggers a reload)',
    hardResetConfirm: 'This will clear all terrain, road, and building data and cache, then reload. Continue?',
    hardResetProgress: 'Clearing…',
    timeSectionTitle: '🕐 Time of day (manual override)',
    timeAuto: '🕐 Auto',
    timeMorning: '🌅 Morning',
    timeNoon: '☀️ Noon',
    timeEvening: '🌇 Evening',
    timeNight: '🌙 Night',
    timeAutoSub: 'Auto',
    timeMorningSub: 'Morning',
    timeNoonSub: 'Noon',
    timeEveningSub: 'Evening',
    timeNightSub: 'Night',
    timeDesc: 'Fix the time to noon to check building colors (useful if buildings look purplish)',
    charSectionTitle: '🧍 Character',
    charBoy: '👦 Boy',
    charGirl: '👧 Girl',
    camDirSectionTitle: '🔄 Camera rotation direction',
    camDirStandard: 'Standard',
    camDirInverted: 'Inverted',
    uiToggleTitle: 'Show/hide UI',
    mapHintDefault: 'Tap a location to jump there',
    mapSearchPlaceholder: 'Search by place, address, or facility name',
    jumpHistorySummary: '🕘 History',
    mapSearchBtnLabel: '🔎 Search',
    geoBtnLabel: '📡 My location',
    helpBody: 'PC: WASD to move / Shift to dash / Space to jump / drag to rotate view / C to toggle altitude hold / B to toggle 🐦BIRD mode (float, 3x speed, Space up / Ctrl down)<br>Mobile: left stick to move (tilt further to speed up) / swipe right side to rotate view / ⤴ to jump / 🔓 to toggle altitude hold / 🐦 to toggle BIRD mode (⤴ up / ⤵ down)',
    closeBtn: 'Close',
    statusInitial: '🗺 Loading Isehara map...',
    debugLegendHtml: '🩺From left: terrain / road+rail / building<span style="background:#555555"></span>not fetched<span style="background:#3388dd"></span>waiting<span style="background:#dd3333"></span>fetching<span style="background:#ffaa22"></span>generating<span style="background:#33cc55"></span>done<span style="background:#9b3fd4"></span>gave up (unreached)',
    altKeepTitleOff: 'Altitude hold (tap while airborne)',
    altKeepTitleOn: 'Altitude hold on (tap to release)',
    birdBtnTitleOff: 'BIRD mode (float, 3x speed)',
    birdBtnTitleOn: 'BIRD mode on (tap to release)',
    birdDownBtnTitle: 'Descend (while in BIRD mode)',
    // ---- 動的メッセージ(part4/6/7/8.js) ----
    mapHintJumpTo: '📍 Jumping to {name}!',
    mapHintSearching: '🔎 Searching for "{q}"...',
    mapHintNotFound: '⚠️ "{q}" was not found',
    mapHintGeoUnsupported: '⚠️ This device/browser does not support location services',
    mapHintGeoHttpsOnly: '⚠️ Location services require an HTTPS connection (will not work over LAN like http://192.168...; please try the https version, e.g. on Render)',
    mapHintGeoFetching: '📡 Fetching your location...',
    mapHintGeoJump: '📍 Jumping to your location!',
    mapHintGeoFailed: '⚠️ Could not get your location ({reason})',
    geoPermissionDenied: 'Location permission was denied',
    // 【2026-07-27・GPS follow mode (Mode A)】extra strings for the toggled location button
    geoBtnTitleOff: 'Start GPS follow (walk outside and your character follows)',
    geoBtnTitleOn: 'GPS follow is on (tap to stop)',
    geoBtnLabelActive: '🛰 Following',
    geoFollowBadgeLabel: '🛰 GPS Following',
    geoFollowBadgeTitle: 'Tap to stop',
    mapHintGeoTracking: '📡 Following your GPS location (tap the location button to stop anytime)',
    mapHintGeoStopped: '📡 GPS follow stopped',
    mapHintGeoBlocked: '⚠️ Location access is blocked for this site. Tap the 🔒 (site info) icon near the address bar, allow Location, then try again',
    mapHintGeoTimeout: '⚠️ Location request timed out. On iPhone, check Settings → Privacy & Security → Location Services is ON and Settings → Chrome → Location is set to "Ask Next Time or When I Share"; if it still doesn\'t work, fully close and reopen the app',
    gpsElevation: 'Elevation {elev}m',
    gpsOpenGoogleMaps: 'Open in Google Maps',
    meijiLanduseLabel: 'Meiji-era land use',
    meijiLanduseEdoLabel: 'Meiji-era data (as an Edo-era approximation)',
    meijiLoadingToast: 'Loading {label} data...',
    meijiLoadedToast: '{label}: {count} points loaded',
    terrainLoadingRegion: '🏔 Loading terrain for this area...',
    terrainApplied: '🏔 Terrain updated',
    terrainFarFailRetry: '⚠️ Failed to fetch distant terrain (retrying automatically)',
    terrainFarGiveUp: '⚠️ Could not fetch distant terrain data (continuing with flat terrain)',
    mapLoadingToast: '🗺 Loading map...',
    cleanupDoneToast: '🧹 Cleaned up areas away from your current location (geometries {before} to {after})',
    mapShownToast: '✨ Map displayed',
    mapPartialFailToast: '⚠️ Some map data failed to load (retrying in the background)',
    meijiCreditBase: 'Meiji-era land use: source <a href="https://habs.rad.naro.go.jp/" target="_blank" style="color:#cdb">NARO Institute for Agro-Environmental Sciences</a> (Rapid Survey Maps, CC BY 4.0)',
    meijiCreditEdoNote: '<br>*No surveyed maps exist from the Edo era, so Meiji-era data is used as an approximation',
    edoRealDataCredit: '<br>Edo-era roads/machiya areas: source <a href="https://codh.rois.ac.jp/historical-gis/" target="_blank" style="color:#cdb">ROIS-DS Center for Open Data in the Humanities</a> "Edo Road Dataset" / "Edo Kiriezu Machiya Area Dataset" + <a href="https://rekichizu.jp/" target="_blank" style="color:#cdb">Rekichizu</a> (all CC BY 4.0)',
    deployInfoUnavailable: 'Deploy time: unavailable (please open via the server)',
    deployInfoLine: '🚀 Deploy time: {time}',
    deployInfoCommitSuffix: ', commit: {time}',
  },
};
let currentLang = 'ja';
try { currentLang = localStorage.getItem('iseharaLang') || 'ja'; } catch (e) {}
function t(key, vars) {
  let s = (I18N[currentLang] && I18N[currentLang][key]) || I18N.ja[key] || key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}
function setLang(lang) {
  currentLang = lang;
  try { localStorage.setItem('iseharaLang', lang); } catch (e) {}
  applyI18n();
}
// data-i18n系属性を持つ全要素へ現在言語のテキストを反映し、続けて他part.jsが持つ
// 「現在の状態(視点モード・描写プリセット・視点回転向き・高度キープ等)依存で
// 中身が変わる動的ラベル」の再描画関数も呼ぶ(state依存のためdata-i18n属性の
// 一括置換だけではカバーできない)。該当スクリプトが未読み込みでも安全なようtypeof確認する。
function applyI18n() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.getAttribute('data-i18n-title')); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
  if (typeof refreshModeLabel === 'function') refreshModeLabel();
  if (typeof refreshViewLabel === 'function') refreshViewLabel();
  if (typeof refreshPerfLabel === 'function') refreshPerfLabel();
  if (typeof updateCamDirBtn === 'function') updateCamDirBtn();
  if (typeof updateAltKeepBtn === 'function') updateAltKeepBtn();
  if (typeof updateGeoBtnUI === 'function') updateGeoBtnUI();
  if (typeof updateLangButtons === 'function') updateLangButtons();
  if (typeof refreshMeijiCredit === 'function') refreshMeijiCredit();
  if (typeof refreshDeployInfo === 'function') refreshDeployInfo();
}

// Prevent default touch scroll everywhere
document.documentElement.style.touchAction = 'none';
document.body.style.touchAction = 'none';

// ======= 表示モード =======
// 地形・道路・当たり判定・ゲームロジックは全モード共通。見た目(マテリアル/ジオメトリ/環境色)のみ差し替える。
// 切替は localStorage に保存してリロード=ワールド全体をそのモードで再生成(最も安全な「チャンク再構築」)。
// 【2026-07-22】labelを「絵文字1個+i18nキー」に分解(UI言語切替対応)。
// 絵文字部分は言語に関わらず固定、テキスト部分だけt()で切り替える。
const VISUAL_MODES = [
  { id: 'real',    icon: '🏙', key: 'modeReal' },
  { id: 'meiji',   icon: '🌾', key: 'modeMeiji' },
  { id: 'edo',     icon: '🏯', key: 'modeEdo' },
  { id: 'marchen', icon: '🍭', key: 'modeMarchen' },
  { id: 'space',   icon: '🛸', key: 'modeSpace' },
];
let MODE = 'real';
try {
  const m = localStorage.getItem('iseharaVisualMode');
  if (VISUAL_MODES.some(v => v.id === m)) MODE = m;
} catch (e) {}
// 現在のMODEに応じたモードボタンのアイコン・ラベルを再描画する(言語切替時にも
// applyI18n()から呼ばれる。「今まさに画面に表示されている」状態依存ラベルのため)。
function refreshModeLabel() {
  const idx = VISUAL_MODES.findIndex(v => v.id === MODE);
  const icoEl = document.getElementById('modeIco'), subEl = document.getElementById('modeSub');
  if (icoEl) icoEl.textContent = VISUAL_MODES[idx].icon;
  if (subEl) subEl.textContent = t(VISUAL_MODES[idx].key);
}
(function initModeBtn() {
  const btn = document.getElementById('modeBtn');
  refreshModeLabel();
  bindTapButton(btn, () => {
    const curIdx = VISUAL_MODES.findIndex(v => v.id === MODE);
    const next = VISUAL_MODES[(curIdx + 1) % VISUAL_MODES.length].id;
    try {
      localStorage.setItem('iseharaVisualMode', next);
      // 現在位置と向きを保存 → リロード後の loadOSM がここから再開する(スポーンに戻さない)
      const ll = xzToLatLon(player.position.x, player.position.z);
      localStorage.setItem('iseharaResumePos',
        JSON.stringify({ lat: ll.lat, lon: ll.lon, yaw: camYaw, rot: player.rotation.y }));
    } catch (e) {}
    location.reload();
  });
})();

// モード切替リロード用の再開位置(1回読んだら消す — 通常リロードは従来どおりスポーン地点)
function consumeResumePos() {
  try {
    const s = localStorage.getItem('iseharaResumePos');
    if (!s) return null;
    localStorage.removeItem('iseharaResumePos');
    const p = JSON.parse(s);
    if (typeof p.lat === 'number' && typeof p.lon === 'number') return p;
  } catch (e) {}
  return null;
}
// 【2026-07-24追加】クラッシュ・タブ強制終了からの再開用(ユーザー要望)。
// iseharaResumePosはモード切替・遠方ジャンプ直前にだけ明示的にセットされる「1回きり」の
// マーカーだが、クラッシュはJSが何も実行できないまま終わるため、その仕組みには乗れない。
// 代わりに、プレイ中ずっと定期的(saveLastPosを一定間隔で呼ぶ。part9.js参照)に現在地を
// 上書き保存しておき、次回起動時に(iseharaResumePosが無ければ)ここから再開する。
// 読み捨てにはせず(consumeResumePosと違い削除しない)、次の定期保存でまた上書きされる
// 「常に最新の現在地」を指すポインタとして扱う。
function readLastPos() {
  try {
    const s = localStorage.getItem('iseharaLastPos');
    if (!s) return null;
    const p = JSON.parse(s);
    if (typeof p.lat === 'number' && typeof p.lon === 'number') return p;
  } catch (e) {}
  return null;
}
function saveLastPos() {
  try {
    const ll = xzToLatLon(player.position.x, player.position.z);
    localStorage.setItem('iseharaLastPos',
      JSON.stringify({ lat: ll.lat, lon: ll.lon, yaw: camYaw, rot: player.rotation.y }));
  } catch (e) {}
}
// モード別の環境パレット
const MODE_CONF = {
  real: {
    fog: 0x3080b0, ambient: 0x9070d0, ambInt: 2.5, moon: 0xd0c0ff,
    sky: ['#0a2a60', '#1a5090', '#3090c0', '#80d0f0'], glow: 'rgba(200,100,50,0.5)',
    water: 0x2277bb, lawn: 0x4a8a3d, roadMinor: 0xe8e8e8, windowC: 0xffee88,
  },
  meiji: { // 明治(迅速測図)— 落ち着いた自然色・薄暮
    fog: 0x8a9a88, ambient: 0xb8b8a0, ambInt: 2.4, moon: 0xe8dcc0,
    sky: ['#1a2a3a', '#3a5a6a', '#7a9a8a', '#d8c8a0'], glow: 'rgba(220,170,90,0.45)',
    water: 0x3a6a8a, lawn: 0x5a7a3a, roadMinor: 0x907a55, windowC: 0xffb066, // 【2026-07-25】行灯・蝋燭風の暖色に変更(旧0xffcc77)
  },
  edo: { // セピア・和
    fog: 0x8a7a5a, ambient: 0xc0a878, ambInt: 2.3, moon: 0xffe8c0,
    sky: ['#2a2018', '#4a3a28', '#7a6040', '#c8a870'], glow: 'rgba(255,180,80,0.5)',
    water: 0x4a7a8a, lawn: 0x6a7a40, roadMinor: 0xcabc9a, windowC: 0xff9944, // 【2026-07-25】蝋燭風の深い橙色に変更(旧0xffd890)
  },
  marchen: { // 明るいパステル
    fog: 0x88c8e8, ambient: 0xd0c0f0, ambInt: 3.2, moon: 0xfff0d0,
    sky: ['#3a70c8', '#5a9ae0', '#90c8f0', '#ffd8e8'], glow: 'rgba(255,160,220,0.6)',
    water: 0x55ccff, lawn: 0x66d060, roadMinor: 0xf2e2e8, windowC: 0xfff0a0,
  },
  space: { // 宇宙コロニー
    fog: 0x0a0e1a, ambient: 0x8090c0, ambInt: 2.2, moon: 0xa0c0ff,
    sky: ['#000006', '#01020e', '#040820', '#0a1030'], glow: 'rgba(80,120,255,0.35)',
    water: 0x113355, lawn: 0x3a4450, roadMinor: 0x556070, windowC: 0x66eeff,
  },
}[MODE];
const IS_MEIJI = MODE === 'meiji';
// 江戸: 当時の実測地図データが無いため、明治期(迅速測図)土地利用データを近似として流用する。
// (現代のOSM建物をそのまま使うと、明治より江戸の方が高層建築だらけになってしまうため)
const USES_MEIJI_LANDUSE = IS_MEIJI || MODE === 'edo';
// 明治期土地利用データの出典表記(CC BY 4.0 の帰属表示。江戸モードでも同データを使うため表示する)。
// 言語切替中も「今まさに画面に表示されている」文言のため、関数化してapplyI18n()からも呼べるようにする。
function refreshMeijiCredit() {
  if (!USES_MEIJI_LANDUSE) return;
  const cr = document.getElementById('credit');
  if (!cr) return;
  cr.style.display = 'block';
  cr.innerHTML = t('meijiCreditBase') + (MODE === 'edo' ? t('meijiCreditEdoNote') : '') + t('edoRealDataCredit');
}
refreshMeijiCredit();

// ======= SCENE SETUP =======
const canvas = document.getElementById('canvas');
// logarithmicDepthBuffer: 標準の深度バッファは近い場所(near付近)に精度が偏り、遠い/高い場所ほど
// 精度が急激に粗くなる。このゲームはnear=0.5〜far=5000(比が1万倍)と幅が広く、上空へ上昇して
// カメラ〜地形間の距離が伸びるほど、地形と海面のような近接した2枚のポリゴンがz-fighting
// (どちらが手前か毎フレーム入れ替わってちらつく)しやすくなる。対数深度バッファは全体に精度を
// 均等に配分するため、この「高度が上がるほどちらつきが悪化する」症状に直接効く。
// 【2026-07-28・GPUメモリ2GB問題】ここが「アプリのジオメトリ・テクスチャではないGPUメモリ」の
// 最有力候補。既定のドローイングバッファは常にGPUに常駐し、しかも
//   ・antialias:true → WebGLのバックバッファがマルチサンプル(Chrome/ANGLEでは通常4x)になり、
//     カラーと深度ステンシルの両方が4倍のメモリを占める
//   ・setPixelRatio(min(dpr,2)) → 高DPI/大画面ではピクセル数が最大4倍
// が掛け算になる。例: 2560x1440のウィンドウ・dpr=2 なら 5120x2880 = 1474万px で
//   MSAAカラー 14.7M×4B×4 = 236MB / MSAA深度ステンシル 236MB / 解決後カラー 59MB ≈ 530MB。
// 4Kや150%スケーリングだと1GB近くに達する。これは【シーンの中身と無関係な固定費】なので、
// PERFプリセットをliteに下げても距離を縮めても1バイトも減らない = 「liteでも落ちる」
// 「データ量を減らす対策が原理的に効かない」という実測と完全に一致する。
// 対策: MSAAを既定でオフ、かつドローイングバッファの総ピクセル数に上限を設ける
// (解像度そのものではなく面積で抑えるので、縦長・横長どちらでも効く)。
// A/B用に localStorage で上書きできる。DevToolsから setGfx(true) / setGfx(false, 4000000) など。
const GFX = (() => {
  let aa = false, maxPx = 2000000; // 2.0Mpx ≒ 1920x1080相当
  try {
    const a = localStorage.getItem('gfxAA'); if (a !== null) aa = (a === '1');
    const m = parseFloat(localStorage.getItem('gfxMaxPx')); if (Number.isFinite(m) && m >= 200000) maxPx = m;
  } catch (e) {}
  return { aa, maxPx };
})();
function gfxPixelRatio() {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  const areaCap = Math.sqrt(GFX.maxPx / (w * h));
  return Math.max(0.5, Math.min(window.devicePixelRatio || 1, 2, areaCap));
}
window.setGfx = (aa, maxPx) => {
  try {
    localStorage.setItem('gfxAA', aa ? '1' : '0');
    if (maxPx) localStorage.setItem('gfxMaxPx', String(maxPx));
  } catch (e) {}
  location.reload();
};
const renderer = new THREE.WebGLRenderer({ canvas, antialias: GFX.aa, logarithmicDepthBuffer: true });
renderer.setPixelRatio(gfxPixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
// 影を無効化 — 3000m範囲を1024pxで描く影は約3m/texelでほぼ視認できず、
// シャドウパスで全建物を毎フレーム二重描画するコストだけが残るため
renderer.shadowMap.enabled = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;

const scene = new THREE.Scene();
// フォグ: 高密度モード(明治以外)は生成半径を狭めた分だけ濃くして、ポップインを隠す。
// 宇宙は大気(=光の散乱)が無い設定なので、遠くまでくっきり見えるようフォグをごく薄くする。
const WORLD_FOG = new THREE.FogExp2(MODE_CONF.fog, MODE === 'meiji' ? 0.0004 : MODE === 'space' ? 0.00008 : 0.00056); // 毎フレーム new しない(GC対策)
scene.fog = WORLD_FOG;
// 【2026-07-23追加】夜は元のフォグ濃度を基準に少し薄くし、遠くの窓明かりが霞まず届くようにする
// (applyTimeOfDayで毎回この基準値から計算し直す。density自体を直接書き換え続けると
// 呼ぶたびに薄くなり続けるバグになるため、必ずこの定数を起点にする)。
const BASE_FOG_DENSITY = WORLD_FOG.density;

// 宇宙は遠景メッシュ(半径6km)がカバーする範囲まで見えるよう視界を伸ばす(他モードは従来通り)
const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.5, MODE === 'space' ? 5800 : 5000);

// ======= FANTASY SKY =======
// 半径はカメラの far(5000) より十分小さく。原点固定だったのをカメラ追従に変更
// (以前は原点から100m以上離れると球の反対側がfarクリップされ、マップジャンプで
//  球の外に出ると空が完全に消えていた)
let skyMesh = null, skyCanvas = null, skyCtx = null, skyTex = null;
function buildSky() {
  const geo = new THREE.SphereGeometry(4000, 32, 32);
  skyCanvas = document.createElement('canvas');
  skyCanvas.width = 512; skyCanvas.height = 512;
  skyCtx = skyCanvas.getContext('2d');
  const grad = skyCtx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0,   MODE_CONF.sky[0]);
  grad.addColorStop(0.4, MODE_CONF.sky[1]);
  grad.addColorStop(0.7, MODE_CONF.sky[2]);
  grad.addColorStop(1,   MODE_CONF.sky[3]);
  skyCtx.fillStyle = grad;
  skyCtx.fillRect(0,0,512,512);
  // Horizon glow
  const hgrad = skyCtx.createRadialGradient(256,512,0,256,512,300);
  hgrad.addColorStop(0, MODE_CONF.glow);
  hgrad.addColorStop(1, 'rgba(0,0,0,0)');
  skyCtx.fillStyle = hgrad;
  skyCtx.fillRect(0,0,512,512);
  skyTex = new THREE.CanvasTexture(skyCanvas);
  // fog:false — 半径4000ではFogExp2でほぼフォグ色に塗り潰されるため空はフォグ対象外に
  const mat = new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false });
  skyMesh = new THREE.Mesh(geo, mat);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -2; // 最初に背景として描画
  scene.add(skyMesh);

  // 宇宙モード: 地球と衛星を空に浮かべる(skyMeshの子なのでカメラ追従も自動)
  if (MODE === 'space') {
    const ec = document.createElement('canvas'); ec.width = 64; ec.height = 64;
    const eg = ec.getContext('2d');
    eg.fillStyle = '#1a55cc'; eg.fillRect(0, 0, 64, 64);
    eg.fillStyle = '#2a8a3a';
    for (let i = 0; i < 7; i++) { eg.beginPath(); eg.arc(Math.random()*64, Math.random()*64, 5+Math.random()*9, 0, 7); eg.fill(); }
    eg.fillStyle = 'rgba(255,255,255,0.7)';
    for (let i = 0; i < 9; i++) { eg.beginPath(); eg.arc(Math.random()*64, Math.random()*64, 3+Math.random()*7, 0, 7); eg.fill(); }
    const earth = new THREE.Mesh(new THREE.SphereGeometry(420, 24, 18),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(ec), fog: false }));
    earth.position.set(1600, 1500, -2600);
    earth.frustumCulled = false;
    skyMesh.add(earth);
    const moon2 = new THREE.Mesh(new THREE.SphereGeometry(140, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xc8b8e8, fog: false }));
    moon2.position.set(-2200, 900, 1500);
    moon2.frustumCulled = false;
    skyMesh.add(moon2);
  }
}
buildSky();

// ======= STARS =======
// カメラ追従。sizeAttenuation:false にしないと距離3800では1px未満で見えない
let starMesh = null;
(function buildStars() {
  const geo = new THREE.BufferGeometry();
  // 宇宙モードは星を濃く、メルヘンは控えめに
  const count = MODE === 'space' ? 7000 : MODE === 'marchen' ? 1200 : 3000;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i += 3) {
    const phi = Math.random() * Math.PI * (MODE === 'space' ? 0.85 : 0.5);
    const theta = Math.random() * Math.PI * 2;
    const r = 3800;
    pos[i]   = r * Math.sin(phi) * Math.cos(theta);
    pos[i+1] = r * Math.cos(phi);
    pos[i+2] = r * Math.sin(phi) * Math.sin(theta);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: MODE === 'space' ? 2.2 : 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.9 });
  starMesh = new THREE.Points(geo, mat);
  starMesh.frustumCulled = false;
  starMesh.renderOrder = -1;
  scene.add(starMesh);
})();

// ======= LIGHTS =======
const ambientLight = new THREE.AmbientLight(MODE_CONF.ambient, MODE_CONF.ambInt);
scene.add(ambientLight);
const moonLight = new THREE.DirectionalLight(MODE_CONF.moon, 1.8);
moonLight.position.set(-500, 1000, -300);
moonLight.castShadow = false; // 影は全体でrenderer.shadowMap.enabled=false(上記)なのでshadow.*設定は無意味 — CODE_REVIEW_20260717 P2で削除
scene.add(moonLight);

// Warm torch point lights — 地形読み込み後に地表高さへ再配置する(part6.js establishRegionBase 参照)
const torchColors = [0xff6a00, 0xff8c40, 0xffaa60];
const torchLights = [];
for (let i = 0; i < 6; i++) {
  const pt = new THREE.PointLight(torchColors[i%3], 1.2, 300);
  pt.position.set(Math.random()*2000-1000, 4, Math.random()*2000-1000);
  scene.add(pt);
  torchLights.push(pt);
}

// ======= 実時間のデイナイト(朝・昼・夕方・夜) =======
// 実際の時刻から、空グラデーション・フォグ・光(太陽/月)・星の見え方を時間帯に連動させる。
// 宇宙モードは対象外(常に宇宙)。1分ごとに更新。
const _cA = new THREE.Color(), _cB = new THREE.Color();
function _lerpCss(a, b, t) { _cA.set(a); _cB.set(b); return _cA.lerp(_cB, t).getStyle(); }
function _lerpHex(a, b, t) { _cA.setHex(a); _cB.setHex(b); return _cA.lerp(_cB, t).getHex(); }
// キーフレーム: 0時=夜 / 6時=朝(夜明け) / 12時=昼 / 18時=夕方
const DAY_KF = [
  { sky:['#050a1e','#0a1836','#16244e','#2b4270'], glow:0x7c8cdc, glowA:0.22, fog:0x1a2848, sun:0xb9c4ff, sunInt:0.5, amb:0x3a4a7a, ambInt:1.05, star:1.0 },
  { sky:['#33406e','#8a6a90','#e6a878','#ffdca6'], glow:0xffaa5a, glowA:0.50, fog:0xb69a86, sun:0xffd2a0, sunInt:1.25,amb:0x9a8aa0, ambInt:1.75, star:0.12 },
  { sky:['#2a70c8','#4a95e0','#8fc4ef','#cfe8fb'], glow:0xfff0d2, glowA:0.30, fog:0x9fc4e0, sun:0xfff4e0, sunInt:2.3, amb:0xbcd0e6, ambInt:2.5, star:0.0 },
  { sky:['#1e2448','#6a3a68','#d0673c','#ffb060'], glow:0xff783c, glowA:0.50, fog:0xa86a56, sun:0xff9a58, sunInt:1.15,amb:0x8a6a80, ambInt:1.6, star:0.12 },
];
// 【2026-07-24追加】窓明かりの点灯係数。DAY_KF(4点直線補間、6時間刻み)をそのまま使うと、
// 正午キーフレームの直後から18時キーフレームに向けて6時間かけて点灯し始めてしまい、
// 「昼過ぎなのに窓が光っている」状態になっていたため、DAY_KFとは独立に、6-16時は
// 完全消灯・16-18時と4-6時だけ遷移する専用カーブとして持つ(h=0-24の実時間 or
// 手動オーバーライド値を直接渡す)。
function _winLitCurve(h) {
  if (h >= 18 || h < 4) return 1;      // 18時〜翌4時: 点灯
  if (h < 6) return 1 - (h - 4) / 2;   // 4-6時: 1→0(明け方、消えていく)
  if (h < 16) return 0;                // 6-16時: 消灯(朝・昼)
  return (h - 16) / 2;                 // 16-18時: 0→1(夕方、点いていく)
}
// 手動時間帯オーバーライド(⚙時間帯パネルから設定。part7.js参照)。
// nullなら実時刻(従来通り)。0/6/12/18で夜/朝/昼/夕の各キーフレームをそのまま固定表示する。
const TIME_OVERRIDE_H = { night: 0, morning: 6, noon: 12, evening: 18 };
let _timeOverrideH = null;
try {
  const savedT = localStorage.getItem('iseharaTimeOverride');
  if (savedT && TIME_OVERRIDE_H[savedT] != null) _timeOverrideH = TIME_OVERRIDE_H[savedT];
} catch (e) {}
function setTimeOverride(h) { _timeOverrideH = h; applyTimeOfDay(); }
function applyTimeOfDay() {
  if (MODE === 'space') return; // 宇宙は常に宇宙
  let h;
  if (_timeOverrideH != null) {
    h = _timeOverrideH;
  } else {
    const now = new Date();
    h = now.getHours() + now.getMinutes() / 60; // 0..24
  }
  const seg = Math.min(3, Math.floor(h / 6));
  const a = DAY_KF[seg], b = DAY_KF[(seg + 1) % 4];
  const t = (h - seg * 6) / 6;
  if (skyCtx && skyTex) {
    const sky = [0,1,2,3].map(i => _lerpCss(a.sky[i], b.sky[i], t));
    const grad = skyCtx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, sky[0]); grad.addColorStop(0.4, sky[1]);
    grad.addColorStop(0.7, sky[2]); grad.addColorStop(1, sky[3]);
    skyCtx.fillStyle = grad; skyCtx.fillRect(0, 0, 512, 512);
    const glow = _lerpHex(a.glow, b.glow, t);
    const glowA = a.glowA + (b.glowA - a.glowA) * t;
    const r = (glow>>16)&255, g = (glow>>8)&255, bl = glow&255;
    const hg = skyCtx.createRadialGradient(256, 512, 0, 256, 512, 320);
    hg.addColorStop(0, `rgba(${r},${g},${bl},${glowA})`);
    hg.addColorStop(1, 'rgba(0,0,0,0)');
    skyCtx.fillStyle = hg; skyCtx.fillRect(0, 0, 512, 512);
    skyTex.needsUpdate = true;
  }
  WORLD_FOG.color.setHex(_lerpHex(a.fog, b.fog, t));
  ambientLight.color.setHex(_lerpHex(a.amb, b.amb, t));
  ambientLight.intensity = a.ambInt + (b.ambInt - a.ambInt) * t;
  moonLight.color.setHex(_lerpHex(a.sun, b.sun, t));
  moonLight.intensity = a.sunInt + (b.sunInt - a.sunInt) * t;
  // 太陽/月の位置(6時=東の地平, 12時=天頂, 18時=西の地平, 夜=地平下)
  const ang = (h - 6) / 12 * Math.PI, sy = Math.sin(ang);
  moonLight.position.set(Math.cos(ang) * 900, sy * 1000 + (sy < 0 ? -150 : 200), 300);
  const night = a.star + (b.star - a.star) * t; // 1=夜, 0=昼(星の見え方用)
  if (starMesh) starMesh.material.opacity = night;
  // 松明は夜だけ灯す(昼間に暖色の点光源が浮くのを防ぐ)
  torchLights.forEach(l => { l.intensity = 0.1 + night * 1.1; });
  // 【2026-07-23追加・24追加で増光・24再修正で夕方/夜限定に・24再々修正で正午直後の
  // 早すぎる点灯を修正】ビルの窓明かり(夜景)を時間帯に連動させる。新規テクスチャ/
  // ジオメトリは一切増やさず、既存の共有マテリアル(facadeCache、part2.js)の
  // emissiveIntensityだけを毎分(このapplyTimeOfDay呼び出しタイミング)まとめて
  // 書き換える — 過去のGPUクラッシュ対策(テクスチャ増加NG)と両立する。
  // 【バグ修正】当初DAY_KF(4点だけの直線補間)のwinLitで代用していたが、正午(12時)
  // キーフレームの直後から夕方(18時)キーフレームに向けて6時間かけて直線的に
  // 点灯が始まってしまい、「昼過ぎなのにもう窓が光っている」状態になっていた
  // (ユーザー報告で発覚)。DAY_KFとは独立に、6-16時は完全消灯・16-18時と4-6時だけ
  // 遷移する専用カーブ(_winLitCurve)に置き換える。
  const winLit = _winLitCurve(h); // 1=点灯(18時〜翌4時), 0=消灯(6時〜16時)
  // フォグは従来どおり星と同じnightカーブで薄める(遠景の窓明かりが霞まないように)。
  WORLD_FOG.density = BASE_FOG_DENSITY * (1 - night * 0.4);
  if (typeof facadeCache !== 'undefined') {
    // 【2026-07-25追加】史実では江戸・明治の夜は行灯・蝋燭程度の弱い明かりで、現代の
    // 電灯のように窓が煌々と光ることはなかった(ユーザーへの回答参照)。倍率自体も
    // 現実モードの3.0より大きく下げ、色味(windowC)・base強度(part2.js facadeMat)と
    // 合わせてろうそく風の弱い暖色の点灯にする。
    const winGlow = winLit * (USES_MEIJI_LANDUSE ? 1.1 : 3.0);
    facadeCache.forEach((mat) => {
      const base = mat.userData && mat.userData.baseEmi != null ? mat.userData.baseEmi : 0.85;
      mat.emissiveIntensity = base * winGlow;
    });
  }
}
applyTimeOfDay();
setInterval(applyTimeOfDay, 60000); // 1分ごとに時間帯を更新

// ======= COLLISION BOXES =======
let collisionBoxes = [];

// 空間ハッシュグリッド — wouldCollide が全ボックスを線形走査していたため、
// カメラ遮蔽判定(毎フレーム約40回呼ぶ)と合わせて数万判定/フレームになっていた。
// 近傍セルのみの照合に変更して大幅軽量化。
const COLL_CELL = 60;
let collGrid = new Map();
function collGridAdd(box) {
  const x0 = Math.floor(box.min.x / COLL_CELL), x1 = Math.floor(box.max.x / COLL_CELL);
  const z0 = Math.floor(box.min.z / COLL_CELL), z1 = Math.floor(box.max.z / COLL_CELL);
  for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
    const k = gx + ',' + gz;
    let arr = collGrid.get(k);
    if (!arr) { arr = []; collGrid.set(k, arr); }
    arr.push(box);
  }
}
function rebuildCollGrid() {
  collGrid = new Map();
  for (const b of collisionBoxes) collGridAdd(b);
}
let currentChunkKey = null; // generateChunk 実行中のみセット(アンロード時の掃除タグ)

// ======= MINIMAP DATA =======
let minimapBuildings = []; // {x,z,w,d,ck}
const roadRecords = [];   // {x1,z1,x2,z2}
// 道路の空間ハッシュ — 「道路の上に木/建物を置かない」判定を高速化する(全道路の線形走査を避ける)。
// roadRecords へ追加するたび addRoadRecord 経由でここにも登録する。
const ROAD_CELL = 40;
const roadGrid = new Map();
function roadGridAdd(r) {
  const pad = (r.rw || 4) / 2 + 3;
  const gx0 = Math.floor((Math.min(r.x1, r.x2) - pad) / ROAD_CELL), gx1 = Math.floor((Math.max(r.x1, r.x2) + pad) / ROAD_CELL);
  const gz0 = Math.floor((Math.min(r.z1, r.z2) - pad) / ROAD_CELL), gz1 = Math.floor((Math.max(r.z1, r.z2) + pad) / ROAD_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const k = gx + ',' + gz; let arr = roadGrid.get(k);
    if (!arr) { arr = []; roadGrid.set(k, arr); }
    arr.push(r);
  }
}
// 【2026-07-16】後から届いた道路・線路と重なっている既存建物を撤去する。
// 「地形→道路→建物」の順序ゲート(osmTilesReadyAround)には1つ穴があり、タイルが
// 4回失敗して「諦めてloaded扱い」になると道路ゼロのままゲートが通って建物が先に建つ。
// その後の背景リトライで道路データが届いた時、道路の上に建物が居座ったままになっていた
// (移動中の拡張生成で道路生成が追いつかないケースの正体)。道路レコード登録のタイミングで
// 重なる建物を検出し、手続き生成は削除・実建物は再キュー(今度は道路を知った状態で
// fitRealBuildingToRoadsが縮小 or 線路ならdrop)する。
// 【2026-08-02修正・ユーザー報告「まだ線路とぎれが起きている」】このpad/rhwは「建物の実
// フットプリントが道路リボンに文字通り重なっているか」を見る厳密判定で、線路drop等
// 実建物の最終チェック(fitRealBuildingToRoads)と同じ基準にわざと合わせてある。だが
// 手続き生成の建物(generateChunk、part8.js)は配置時、実フットプリント判定ではなく
// LOT_MARGIN(=4、part8.js内のローカル定数)ぶん外側にパディングしたisOnRoad呼び出し
// (`isOnRoad(qx,qz, bw+LOT_MARGIN*2, bd+LOT_MARGIN*2)`)で弾かれる設計になっている。
// 配置時はこの広い余裕を確保していたのに、gaveUpタイル明けの事後清掃(この関数)は
// 厳密判定のままだったため、線路のすぐ脇(重ならないギリギリの範囲)に建てられた
// 手続き生成の家だけが清掃を素通りして残っていた——これが「まだ発生している」の実体
// (調査で確認、[[project_isehara_game_vegetation_on_late_road_rail]]参照)。手続き生成
// (rec.real不在)だけ、配置時と同じ量(PROC_CLEANUP_EXTRA_MARGIN=8、LOT_MARGIN*2相当)を
// 上乗せする。実建物は従来通り厳密判定のまま(fitRealBuildingToRoadsが別途縮小するため、
// ここを広げると健全な実建物まで巻き込んで消してしまう)。
const PROC_CLEANUP_EXTRA_MARGIN = 8;
function removeBuildingsOverlappingRoad(r) {
  if (r.type === 'water') return;
  if (buildingRecords.length === 0) return;
  const rhwReal = (r.rw || 5) / 2 + 0.5;
  const rhwProc = rhwReal + PROC_CLEANUP_EXTRA_MARGIN;
  const pad = 40 + PROC_CLEANUP_EXTRA_MARGIN; // 建物の半対角ぶん+手続き生成の広い余裕ぶんの探索範囲
  const gx0 = Math.floor((Math.min(r.x1, r.x2) - rhwProc - pad) / BUILDING_CELL);
  const gx1 = Math.floor((Math.max(r.x1, r.x2) + rhwProc + pad) / BUILDING_CELL);
  const gz0 = Math.floor((Math.min(r.z1, r.z2) - rhwProc - pad) / BUILDING_CELL);
  const gz1 = Math.floor((Math.max(r.z1, r.z2) + rhwProc + pad) / BUILDING_CELL);
  const removeIds = new Set();
  const seenB = new Set();
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = meshedBuildingGrid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const rec of arr) {
      if (rec.bid == null || seenB.has(rec.bid)) continue;
      seenB.add(rec.bid);
      const rhw = rec.real ? rhwReal : rhwProc;
      // 建物ローカル系で道路リボンとの重なり判定(part2.js fitRealBuildingToRoadsの
      // 線路最終チェックと同じ計算。_minAbsOverWindowはpart2.js定義、実行時参照)
      const c = Math.cos(rec.rot || 0), s = Math.sin(rec.rot || 0);
      const hw = rec.w / 2, hd = rec.d / 2;
      const ax = r.x1 - rec.x, az = r.z1 - rec.z, bx = r.x2 - rec.x, bz = r.z2 - rec.z;
      const au = ax * c - az * s, av = ax * s + az * c;
      const bu = bx * c - bz * s, bv = bx * s + bz * c;
      const du = bu - au, dv = bv - av;
      let overlap;
      if (Math.abs(du) >= Math.abs(dv)) {
        const vmin = _minAbsOverWindow(au, av, du, dv, hw + rhw);
        overlap = vmin !== null && vmin < hd + rhw;
      } else {
        const umin = _minAbsOverWindow(av, au, dv, du, hd + rhw);
        overlap = umin !== null && umin < hw + rhw;
      }
      if (!overlap) continue;
      for (const p of rec.parts) {
        if (!p || p.userData._released) continue; // 【2026-07-20・二重解放バグ修正】下記コメント参照
        p.userData._released = true;
        scene.remove(p);
        if (p.geometry && !p.geometry.userData.shared) p.geometry.dispose();
        if (p.material) releaseFacadeMat(p.material); // facadeMat以外は無害なno-op(part2.js参照)
      }
      removeIds.add(rec.bid);
      if (rec.real) {
        pendingBuildings.push({ x: rec.x, z: rec.z, w: rec.w, d: rec.d, h: rec.h,
          style: rec.style, real: true, rot: rec.rot }); // _fit無し→再fitされる
      }
    }
  }
  removeBuildingsByIds(removeIds);
}
// 【2026-08-02】建物(removeBuildingsOverlappingRoad)と同じ理由で、木・下草も後から届いた
// 道路・線路と重なっていれば取り除く必要がある(ユーザー報告: 線路のあるべき場所に手続き
// 生成の建物や木があり、線路が途切れている)。タイル取得がgaveUp(諦め)で一旦「空地」扱いに
// なり手続き生成が先に走った後、背景リトライで実際の道路・線路データが遅れて届いた場合、
// 建物側はremoveBuildingsOverlappingRoadで自動的に片付くが、木・下草はbuildingRecordsの
// ような個体レコードを持たないInstancedMeshプール管理(part2.js)のため、この清掃の対象外
// のまま放置されていた。プールはbuildingRecordsのような空間グリッドを持たないので、
// instanceMatrixの平行移動成分(x,z)を直接読んで距離判定→スワップ詰めで除去する
// (compactPool と同じ手法、「遠いから捨てる」ではなく「新しい道路/線路と重なるから捨てる」
// 点だけが違う)。街路樹・公園木(treeTrunkP/treeTopPools)は既にcompactPoolの対象で
// インデックス入れ替え耐性が確認済み。森の木(forestTrunkP/forestLeafPools)はnoCompactだが
// rebuildForestが移動のたびpool.nから作り直すため、こちらのスワップ詰めと衝突しない。
function _removePoolInstancesNearSeg(pool, x1, z1, x2, z2, rhw) {
  if (!pool || pool.n === 0) return 0;
  const m = pool.mesh;
  const arr = m.instanceMatrix.array; // Matrix4を並べたFloat32Array(平行移動は12,13,14)
  const col = m.instanceColor ? m.instanceColor.array : null;
  const rhw2 = rhw * rhw;
  let w = 0;
  for (let i = 0; i < pool.n; i++) {
    const o = i * 16;
    const px = arr[o + 12], pz = arr[o + 14];
    if (distSqPointToSeg(px, pz, x1, z1, x2, z2) < rhw2) continue; // 重なる→詰めずに捨てる
    if (w !== i) {
      arr.copyWithin(w * 16, o, o + 16);
      if (col) col.copyWithin(w * 3, i * 3, i * 3 + 3);
      if (pool.resnap) pool.resnap[w] = pool.resnap[i]; // 【2026-08-02】compactPoolと同じくresnap追跡情報も一緒に移す
    }
    w++;
  }
  const removed = pool.n - w;
  if (removed === 0) return 0;
  pool.n = w;
  m.count = w;
  m.instanceMatrix.needsUpdate = true;
  if (col) m.instanceColor.needsUpdate = true;
  return removed;
}
function _doRemoveVegetationOverlappingRoad(x1, z1, x2, z2, rhw) {
  _removePoolInstancesNearSeg(treeTrunkP, x1, z1, x2, z2, rhw);
  for (const p of treeTopPools) _removePoolInstancesNearSeg(p, x1, z1, x2, z2, rhw);
  _removePoolInstancesNearSeg(forestTrunkP, x1, z1, x2, z2, rhw);
  for (const p of forestLeafPools) _removePoolInstancesNearSeg(p, x1, z1, x2, z2, rhw);
  _removePoolInstancesNearSeg(scrubP, x1, z1, x2, z2, rhw);
}
// 【2026-08-02修正・ユーザー報告「動きが重くなった/移動中に頻繁にフリーズする」】
// removeBuildingsOverlappingRoad は建物側に空間グリッド(meshedBuildingGrid)があるので
// 近傍だけを見て安いが、木・下草のプールには同種のグリッドが無く、_removePoolInstancesNearSeg
// は毎回プール全件(最大3〜4万件×8プール)を線形走査する。当初はaddRoadRecordから道路・線路の
// セグメント1本ごとに同期呼び出ししていたが、1タイル分のOSM応答(processTileData)は数十〜
// 数百セグメントをforEachで一気に処理する1回の同期JS呼び出しのため、そのぶん丸ごと
// 走査コストが掛け算されてメインスレッドが固まっていた(道路メッシュ生成が
// pendingRoadMeshes+processRoadMeshQueueでフレーム予算制になっているのと同じ理由で、
// これも同期実行してはいけない処理だった)。road/roadMeshキューと同じフレーム予算方式に
// 変更し、addRoadRecordでは安いディスクリプタをキューに積むだけにする。
const _vegCleanupQueue = [];
function queueVegetationCleanup(r) {
  if (r.type === 'water') return; // removeBuildingsOverlappingRoadと同じ扱い(水面幅は実測ではない推定値のため)
  const rhw = (r.rw || 5) / 2 + 2; // 建物より広めの余裕(樹冠・下草の見た目の半径ぶん)
  _vegCleanupQueue.push({ x1: r.x1, z1: r.z1, x2: r.x2, z2: r.z2, rhw });
}
const VEG_CLEANUP_BUDGET_MS = 4; // 1フレームあたりの上限。既存の除去(遅れて片付く)は許容、フリーズは許容しない
function processVegCleanupQueue() {
  if (_vegCleanupQueue.length === 0) return;
  const t0 = performance.now();
  let i = 0;
  while (i < _vegCleanupQueue.length) {
    if ((i & 3) === 0 && performance.now() - t0 > VEG_CLEANUP_BUDGET_MS) break;
    const e = _vegCleanupQueue[i++];
    _doRemoveVegetationOverlappingRoad(e.x1, e.z1, e.x2, e.z2, e.rhw);
  }
  if (i > 0) _vegCleanupQueue.splice(0, i);
}
// roadRecords.push の共通化: 記録と同時に空間グリッドへ登録
function addRoadRecord(r) { roadRecords.push(r); roadGridAdd(r); removeBuildingsOverlappingRoad(r); queueVegetationCleanup(r); }

// 【2026-08-03・修正A】widSetに含まれるway由来のroadRecordを、タイル境界・現在の位置を
// 一切問わず全部削除する。reviveStaleTiles(タイル作り直し)・evictFarRoads(遠方全滅判定)
// から使う。「そのwayをun-seeする」操作と必ずセットで(原子的に)呼ぶこと——un-seeだけ
// 先にやると、再取得時にこの削除より前の古いレコードの上に同じ道路がもう1本積まれる
// (dropTileRemnants/resetTileForRefetchのコメント参照)。
function removeRoadRecordsByWid(widSet) {
  if (!widSet || widSet.size === 0) return 0;
  let w = 0, dropped = 0;
  for (let i = 0; i < roadRecords.length; i++) {
    const r = roadRecords[i];
    if (r.wid == null || !widSet.has(r.wid)) { roadRecords[w++] = r; continue; }
    if (r.mesh) { scene.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh = null; }
    if (r.railWhite) { scene.remove(r.railWhite); r.railWhite.geometry.dispose(); r.railWhite = null; }
    r._dropped = true;
    dropped++;
  }
  if (dropped > 0) {
    roadRecords.length = w;
    roadGrid.clear();
    for (const r of roadRecords) roadGridAdd(r);
  }
  return dropped;
}

// 【2026-08-02・ユーザー報告「マップジャンプ後に木や信号機が空中に浮かんでいる」】
// 建物(rebuildBuildingHeight)・道路(rebuildRoadsInBounds)・森の木(rebuildForest、
// 2026-07-20対策)は、NEAR地形が更新されるたび(part6.js loadNearTerrain成功時)に
// Y座標を再計算して追従する仕組みを持つ。だが街路樹・公園木(addTree)・道路小物
// (信号機・電柱・街灯・横断歩道、decorateRoad/addRoad)は個体レコードを持たず
// InstancedMeshプールへの一回限りの追記のみだったため、この追従の対象外だった。
// マップジャンプ直後は新しい地点のNEAR地形がまだ届いておらず、getGroundY(part6.js
// terrainY)が古い地域のNEARグリッドか、それも範囲外なら0m基準にフォールバックするため、
// この間に配置された木・信号機等はそのままの高さで固定され、後からNEAR地形が届いても
// 誰も再計算しないため浮いた/埋まったまま残っていた。
//
// 生成時にpool.resnap[idx]へ{x,z,yOff}を登録しておき(trackResnapInstance)、NEAR地形更新時
// (part6.js)にその範囲内のインスタンスだけY座標を再サンプリングする(resnapPropsAndTreesInBounds)。
// 【重要・キューにしなかった理由】当初は木・下草の事後清掃(queueVegetationCleanup)と同じ
// フレーム予算キューにする案だったが、そのキューに積んだ後で別のスワップ詰め処理
// (compactPool、または上のqueueVegetationCleanup自体)が同じプールのインデックスを
// 動かすと、キュー内の古いidxが「別の(無関係な)インスタンス」を指してしまい、その
// インスタンスのY座標を誤って書き換える事故になりうる(単に古いバグが残るより悪い)。
// これを避けるため、pool.resnap配列自体をcompactPool/_removePoolInstancesNearSegの
// スワップ詰めと同時に同期更新するようにし(該当箇所参照)、再スナップ自体もキューを介さず
// 呼び出しの瞬間に同期実行する(rebuildBuildingsInBounds/rebuildStationsInBoundsと同じ方式。
// 対象半径がRESNAP_HALF_M=3600mに絞られ、NEAR地形更新時のみ発火する低頻度処理なので、
// 同期実行でも許容できると判断——道路/線路セグメント1本ごとに高頻度発火していた
// [[project_isehara_game_vegetation_on_late_road_rail]]のケースとは負荷特性が異なる)。
function trackResnapInstance(pool, idx, x, z, yOff) {
  if (idx == null || idx < 0 || !pool || !pool.resnap) return; // poolAddはプール満杯時-1を返す(生成自体スキップ)
  pool.resnap[idx] = { x, z, yOff };
}
function _resnapPoolInBounds(pool, x0, x1, z0, z1) {
  if (!pool || !pool.resnap) return;
  for (let i = 0; i < pool.n; i++) {
    const e = pool.resnap[i];
    if (!e || e.x < x0 || e.x > x1 || e.z < z0 || e.z > z1) continue;
    poolSetY(pool, i, getGroundY(e.x, e.z) + e.yOff);
  }
}
function resnapPropsAndTreesInBounds(x0, x1, z0, z1) {
  _resnapPoolInBounds(treeTrunkP, x0, x1, z0, z1);
  for (const p of treeTopPools) _resnapPoolInBounds(p, x0, x1, z0, z1);
  _resnapPoolInBounds(signalP, x0, x1, z0, z1);
  _resnapPoolInBounds(poleP, x0, x1, z0, z1);
  _resnapPoolInBounds(lampP, x0, x1, z0, z1);
  _resnapPoolInBounds(xwalkP, x0, x1, z0, z1);
}
// 矩形範囲にかかる可能性のある道路だけを空間ハッシュから拾う(roadRecords全件走査を避ける)
function queryRoadGrid(x0, x1, z0, z1) {
  const gx0 = Math.floor(x0 / ROAD_CELL), gx1 = Math.floor(x1 / ROAD_CELL);
  const gz0 = Math.floor(z0 / ROAD_CELL), gz1 = Math.floor(z1 / ROAD_CELL);
  const seen = new Set(), out = [];
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = roadGrid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const r of arr) { if (!seen.has(r)) { seen.add(r); out.push(r); } }
  }
  return out;
}

// ======= ポリゴン(避けエリア・landuse・水/公園/田畑メッシュ)用の汎用空間ハッシュ =======
// 【重要】これらは取得したタイル分だけ増え続けて一切減らないため、以前は
// generateChunk() や rebuildAreaPolysInBounds() が毎回配列を全件線形走査(filter)して
// いた。探索距離が伸びるほど1回あたりのコストが線形に悪化し、長時間プレイで
// 「移動を続けると徐々に重くなり最終的に落ちる」症状の主因の一つになっていた。
// ポリゴンは道路よりずっと広い範囲を覆うことがあるため、道路用より粗いセルを使う。
const POLY_CELL = 200;
function polyGridAdd(grid, entry) {
  const gx0 = Math.floor(entry.minX / POLY_CELL), gx1 = Math.floor(entry.maxX / POLY_CELL);
  const gz0 = Math.floor(entry.minZ / POLY_CELL), gz1 = Math.floor(entry.maxZ / POLY_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const k = gx + ',' + gz;
    let arr = grid.get(k);
    if (!arr) { arr = []; grid.set(k, arr); }
    arr.push(entry);
  }
}
function queryPolyGrid(grid, x0, x1, z0, z1) {
  const gx0 = Math.floor(x0 / POLY_CELL), gx1 = Math.floor(x1 / POLY_CELL);
  const gz0 = Math.floor(z0 / POLY_CELL), gz1 = Math.floor(z1 / POLY_CELL);
  const seen = new Set(), out = [];
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = grid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const e of arr) { if (!seen.has(e)) { seen.add(e); out.push(e); } }
  }
  return out;
}
// 座標(x,z)が属するlanduse区画の種別(residential/commercial/industrial/retail等)を返す
// (無ければnull)。generateChunk内のluTypeAtと同じ考え方だが、building=yesだけでタグ
// (サブタイプ)が無い大きな建物を住宅(マンション)/商業(オフィス)のどちらに寄せるか
// (part3.js classifyResidential)でも使う汎用版。
// 【重要】landusePolygonsはこのバッチ自身の分がまだ積まれていないことがある(part6.js
// PASS2=建物 → PASS3=landuseの順、part8.jsも建物パス→landuseパスの順のため)。
// その場合はnullを返し、呼び出し側は既存の既定動作(マンション扱い)にフォールバックする。
function landuseTypeAt(x, z) {
  const near = queryPolyGrid(landuseGrid, x - 1, x + 1, z - 1, z + 1);
  for (const p of near) {
    if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
    if (pointInPolygon(x, z, p.pts)) return p.lu;
  }
  return null;
}

// 道路メッシュを、現在(呼び出し時点)の getGroundY に合わせて作り直す。
// 以前は道路メッシュを最初に生成した瞬間の地形高さで永久に固定していたため、
// 後からNEAR高解像度地形グリッドが届いて地形の高さが変わると、道路が地面に埋まったり
// 逆に浮いて見えたりしていた。ジオメトリだけ差し替え、Mesh自体・マテリアルは使い回す。
// 【重要】unloadFarRoadsで遠方アンロードされた道路(r.mesh===null)は、このタイミング
// (=プレイヤー付近のチャンクが生成された=近くまで戻ってきた)でメッシュを作り直して復元する。
function rebuildRoadMesh(r) {
  if (r.type === 'motorway') {
    if (r.mesh) { rebuildMotorwayMesh(r); return; }
    // 【2026-07-28・経路シムでのクラッシュ対策】以前は高架(motorway)を距離アンロード対象外に
    // していた(理由:当時は橋脚をInstancedMeshで表現しており個別解放できなかったため)。
    // その後「橋脚は挙動が不安定」として橋脚自体を廃止し、高架は橋脚なしの独立Mesh1本に
    // なった(part3.js addMotorway参照)ため、この除外理由は既に解消済み。一方、経路シムは
    // 無人で長時間・長距離を走り続けるため、高架(OSRM drivingルートで多用される)が
    // 距離アンロードの対象外のまま永久にGPUメモリへ残り続け、クラッシュの一因になっていた
    // ([[project_isehara_game_route_sim_crash_mitigation.md]]の実機コンソールログで
    // GPUプロセスのメモリ肥大を確認)。ここで他の道路と同じ「r.mesh===nullから作り直す」
    // 経路を用意し、unloadFarRoads側もmotorwayを対象に含める(MOTORWAY_UNLOAD_DIST参照)。
    const geo = makeMotorwayGeo(r.x1, r.z1, r.x2, r.z2);
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, realRoadMat('motorway', 24));
    mesh.renderOrder = 1;
    scene.add(mesh);
    r.mesh = mesh;
    if (r.slope) {
      // 既存のslopeオブジェクト(motorwaySlopesに入っている実体)を書き換える。
      // 新規オブジェクトに差し替えるとmotorwaySlopes側が古い(孤立した)実体を参照したまま
      // 重複が増え続けてしまうため、参照は変えずフィールドだけ更新する。
      r.slope.y1 = getGroundY(r.x1, r.z1) + MWY_H;
      r.slope.y2 = getGroundY(r.x2, r.z2) + MWY_H;
    }
    return;
  }
  const geo = makeRoadGeo(r.x1, r.z1, r.x2, r.z2, r.rw, r.yOff, r.bridgeY, r.type);
  if (!geo) return;
  // 橋区間: 見た目のジオメトリと同じタイミングで「乗れる床」(bridgeSlopes)も
  // 同じ高さへ更新する(bridgeSegmentYで両方が全く同じ式を使うため、見た目と
  // 足場が食い違うことはない)。これが無いと、地形が沈んで見えるのは直っても
  // 実際に立とうとすると当たり判定だけ古い/地形のままで下に沈み続ける不具合になる。
  if (r.bridgeY && r.slope) {
    const bh = bridgeSegmentY(r.bridgeY);
    r.slope.y1 = bh.yA; r.slope.y2 = bh.yB;
  }
  if (r.mesh) {
    r.mesh.geometry.dispose();
    r.mesh.geometry = geo;
  } else {
    const mesh = new THREE.Mesh(geo, r.mat);
    mesh.renderOrder = 1;
    scene.add(mesh);
    r.mesh = mesh;
  }
  // 非現実モードの線路(白帯オーバーレイ)も同じタイミングで復元/追従
  if (r.type === 'railway' && !IS_REAL) {
    const rg = makeRoadGeo(r.x1, r.z1, r.x2, r.z2, 1.5, 0.5);
    if (rg) {
      if (r.railWhite) {
        r.railWhite.geometry.dispose();
        r.railWhite.geometry = rg;
      } else {
        const rail = new THREE.Mesh(rg, ROAD_MAT.rail_white);
        rail.renderOrder = 2;
        scene.add(rail);
        r.railWhite = rail;
      }
    }
  }
  // 電柱・電線は撤去済み(2026-07-15。part2.js冒頭のコメント参照)。以前はここで
  // resnapWireSpan()を呼び、道路面と同じタイミングで電柱・電線を地形高さに追従させていた。
}

// ======= 新規投入分をプレイヤー近傍優先に並べ替える(2026-07-15) =======
// 【経緯】OSMタイル1バッチ(密集市街地だと建物・道路とも数千件)は、そのバッチ内では
// 単にOSMが返した順(=プレイヤー位置とは無関係)でpendingBuildings/pendingRoadMeshesに
// 積まれ、フレーム分割処理も配列の先頭からFIFOで消化するだけだった。タイル自体は近い順に
// 取得されるが(fetchOSMTileBatchのソート)、1タイル内の建物・道路の並びまでは近い順に
// なっていないため、密集地では「今プレイヤーが立っている場所」の建物・道路がバッチの
// 後方に埋もれ、生成が追いつかず地形・建物の「端」に行き当たる不具合につながっていた。
// バッチ全体を毎フレーム並べ替えるのはコストが大きいので、新規追加分(fromIdx以降)だけを
// 1回だけ、そのバッチが積まれた直後にプレイヤー位置を中心とした近い順へ並べ替える。
function sortNewEntriesByDistanceToPlayer(arr, fromIdx, getXZ) {
  if (fromIdx >= arr.length) return;
  const px = player.position.x, pz = player.position.z;
  const tail = arr.splice(fromIdx);
  tail.sort((a, b) => {
    const pa = getXZ(a), pb = getXZ(b);
    const da = (pa.x - px) * (pa.x - px) + (pa.z - pz) * (pa.z - pz);
    const db = (pb.x - px) * (pb.x - px) + (pb.z - pz) * (pb.z - pz);
    return da - db;
  });
  for (const t of tail) arr.push(t);
}

// ======= 道路メッシュ生成のフレーム分割 =======
// 以前は addRoad が呼ばれた瞬間に makeRoadGeo(1mごとの地形サンプリング)+Mesh生成+scene.add
// を同期実行していた。密集市街地のOSMタイル(6枚バッチ)が届くと数千セグメントを1フレームで
// 生成することになり、数秒〜数十秒のフリーズの主因だった(東京都心で45秒超を確認)。
// → addRoad はレコード登録(軽量。isOnRoad判定・ミニマップは即座に正しく動く)だけ行い、
//   重いメッシュ生成はこのキューで1フレームあたり時間バジェット内だけ処理する。
// 【2026-07-28】プレイヤーの開始位置が確定したか。
// animate()は起動ブートストラップIIFEより前に呼ばれるため、checkOSMTilesは
// 「位置情報の取得(await startLocP)→jumpToLatLon」より先に回り始める。この数秒の窓に
// タイル応答が届くと、プレイヤーはまだ既定位置に居るので距離判定が全部でたらめになる。
// 距離を根拠に「捨てる/遠方送りにする」判断は、この旗が立つまで絶対に行わない
// (part8.jsの投入時の振り分け、evictFarDormantの恒久削除がこれを見る)。
let worldPosSettled = false;
// 【安全網】位置情報の許可が降りない・ユーザーがプロンプトを無視した場合、ブートストラップの
// await startLocP が長時間解決しないことが実機で確認されている(Chromeは複数回無視されると
// 権限プロンプト自体をブロックする)。旗が立たないままだとアンロード処理が全部止まり、
// 際限なく積み上がって逆にクラッシュを早める。15秒経ったら位置は確定したものとみなす。
setTimeout(() => { worldPosSettled = true; }, 15000);
const pendingRoadMeshes = [];
// 【2026-08-03・診断計器】遠方判定で「作り直し待ち(_dirty)」のまま握りつぶされた回数。
// _commitWaterPoly直後にこれが跳ね上がれば「再キューは発火しているのに距離チェックで
// 消えている」ことの直接証拠になる(IMPL_PROMPT_20260803_BRIDGE_WATER.md 5章の計器)。
let _bridgeDirtyDropped = 0;
function queueRoadMesh(r) {
  if (r._q || r._dropped) return; // 二重投入防止 / 距離破棄済みレコード(evictFarRoads参照)は作らない
  r._q = true;
  pendingRoadMeshes.push(r);
}
function processRoadMeshQueue() {
  if (pendingRoadMeshes.length === 0) return;
  const t0 = performance.now();
  const px = player.position.x, pz = player.position.z;
  const lim2 = ROAD_UNLOAD_DIST * ROAD_UNLOAD_DIST;
  // 【重要・2026-07-15】生成順序は地形→道路→建物のはずが、建物側(part9.js)だけ
  // バックログに応じて予算を最大80棟/フレームまで伸ばす可変制にしていた一方、道路は
  // 常に固定6ms/フレームのままだったため、混雑時は建物の方が道路より速く追いつき、
  // 道路が建物に追い抜かれて「道路だけ拡張が止まって見える」逆転が起きていた。
  // 道路側もバックログに応じて時間予算を伸ばし、常に建物より優先して追いつけるようにする。
  // 【2026-07-19】建物側(part9.js)には起動・ジャンプ直後30秒 or 現在地タイル未完了中の
  // 「初期ラッシュ」で予算を8ms→14msへ広げる仕組みがあるが、道路側には同種のブーストが
  // 無かった。生成順序は「地形→道路→建物」のはずなのに、ラッシュ中はむしろ道路の方が
  // 相対的に手薄になっていた(ユーザー報告: 道路・線路の生成が遅い)。同じ判定を使い、
  // ラッシュ中は上限を24ms→42msへ広げる(この間のコマ落ちは建物側ラッシュと同様に許容)。
  const _roadRush = performance.now() < 30000 || _curTileRush;
  const roadBudgetMs = Math.min(_roadRush ? 42 : 24, 6 + Math.floor(pendingRoadMeshes.length / 150));
  let i = 0;
  while (i < pendingRoadMeshes.length) {
    if ((i & 7) === 0 && performance.now() - t0 > roadBudgetMs) break;
    const r = pendingRoadMeshes[i++];
    r._q = false;
    // 【2026-07-28】キュー投入後にevictFarRoadsで距離破棄されたレコード。ここで作ってしまうと
    // roadRecordsに居ないメッシュがsceneに残り、二度とアンロードされない孤児になる。
    if (r._dropped) continue;
    const mx = (r.x1 + r.x2) / 2 - px, mz = (r.z1 + r.z2) / 2 - pz;
    // 遠方(unloadFarRoadsの解放距離の外)はどうせすぐ解放されるので作らない。
    // プレイヤーが近づけばチャンク再生成(rebuildRoadsNearChunk)やNEAR更新
    // (rebuildRoadsInBounds)が再キューするので、恒久的に欠けることはない。
    // 細街路(road/tertiary)はさらに短いMINOR_ROAD_MESH_DISTで切る(メッシュ総数対策)。
    // 高架(motorway)は逆にunloadFarRoadsと同じMOTORWAY_UNLOAD_DIST(長め)を使う。
    const _rlim2 = r.type === 'motorway' ? MOTORWAY_UNLOAD_DIST * MOTORWAY_UNLOAD_DIST
      : isMinorRoadType(r.type) ? MINOR_ROAD_MESH_DIST * MINOR_ROAD_MESH_DIST : lim2;
    // 【2026-08-03・橋の水没不具合の決定打を修正】以前はここで`r._dirty = false`を書いていた。
    // 「今は遠いので作らない」という距離都合の見送りを、「もう作り直す必要はない」という
    // 恒久的な判断に書き換えてしまっていた。水面が先読みで先に届き、その後`_commitWaterPoly`が
    // 遠方の橋を`_dirty=true`にして再キューしても、ここで即座にfalseへ戻されて握りつぶされ、
    // プレイヤーが近づいても`if (r.mesh && !r._dirty) continue;`で永久にスキップされていた
    // (=「捨てる/見送る」と「もう不要」を混同した典型例。IMPL_PROMPT_20260803_BRIDGE_WATER.md
    // 大原則13「今はやらないをやらなくてよいに変換しない」)。_dirtyは絶対に落とさず、
    // 範囲内に戻ってきた時にunloadFarRoads側が拾い直す(下記の対応する修正を参照)。
    if (mx * mx + mz * mz > _rlim2) { if (r._dirty) _bridgeDirtyDropped++; continue; }
    if (r.mesh && !r._dirty) continue; // 既に構築済みで地形も変わっていない
    rebuildRoadMesh(r);
    r._dirty = false;
  }
  pendingRoadMeshes.splice(0, i);
}

// 【重要】道路・線路は建物と違い、これまで距離に関係なく永久にscene・GPUメモリに
// 残り続けていた(1本ごとに専用ジオメトリのMeshをscene.addするだけで、チャンクアンロード
// でも消えない)。探索範囲が広がるほど道路メッシュが際限なく積み上がり、長時間移動を
// 続けるとGPUメモリ・描画コールが持たずに重くなって落ちる症状の主因になっていた。
// ここでは建物と違い、roadRecords/roadGrid(=isOnRoad判定・ミニマップ・踏切検出が
// 恒久的に参照する軽量データ)自体は消さず、GPU側の重いMesh/ジオメトリだけを距離に応じて
// 破棄・復元する(復元は上のrebuildRoadMeshが、プレイヤーが近づいてチャンクが再生成される
// タイミングで自動的に行う)。
// 【2026-07-28修正】高架(motorway)は当初「橋脚がInstancedMeshで個別解放できない」ため
// アンロード対象外だったが、その後橋脚自体を撤去(part3.js addMotorway参照、挙動が不安定
// だったため)し、高架は橋脚なしの独立Mesh1本になったため除外理由は解消済み。経路シムが
// 無人で長距離を走り続けると、OSRM drivingルートで多用される高架が対象外のまま永久に
// GPUメモリへ残り続けクラッシュの一因になっていたため、他の道路と同じくアンロード対象に
// 含めた(ただしMOTORWAY_UNLOAD_DISTで通常の道路よりずっと長く保持する)。
// ======= 【2026-07-16】描写範囲・パフォーマンスプリセット =======
// ⚙ボタン(index.html #perfCtrl、切替処理はpart7.js)で3段階から選択。localStorageに保存し、
// リロードで反映(距離系はconstで各所に焼き込まれるため、モード切替と同じリロード方式)。
// 稼働環境(PCの性能・スマホ)に合わせてユーザー自身が選ぶ。既定は「標準」。
const PERF_PRESET = (() => {
  try {
    const v = localStorage.getItem('perfPreset');
    if (v === 'lite' || v === 'std' || v === 'high') return v; // ユーザーが⚙で明示的に選んだ設定を最優先
  } catch (e) {}
  // 【2026-07-20】iPhone(Chrome)で「標準」のまま数分でクラッシュするという報告への対応。
  // 標準プリセットは密集地でGPUメモリが数GBに達することがあり(下のPERF定義のコメント参照)、
  // PCでは耐えられてもiOS(Chromeも含め全ブラウザの中身はWebKitで、タブのメモリ上限が
  // デスクトップよりずっと厳しい)ではその前にタブごと落ちる。ユーザーが一度も⚙を
  // 触っていない初回起動時に限り、スマホ・タブレット相当の端末は「軽量」を既定にする
  // (上で明示的な保存値を最優先しているので、既に選択済みのユーザーには影響しない)。
  try {
    const ua = navigator.userAgent || '';
    const isMobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua) ||
      (navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.platform || '')); // iPadOSはMac名乗りUAだがタッチあり
    if (isMobile) return 'lite';
  } catch (e) {}
  return 'std';
})();
const PERF = {
  //       道路メッシュ保持 / 実建物 生成・消去 / 手続きチャンク半径(×120m) / 森 / タイル先読み半径(×1600m)
  // 【2026-07-16】標準のbGenRealを3000→2200に調整。IndexedDBタイルキャッシュ導入後は
  // 東京駅級の密集地でも本当に全建物が届く(以前は429で実質フル密度に達していなかった)ため、
  // 3000mフル密度はメモリ超過でクラッシュした。広い描写が欲しい場合は高品質を選ぶ。
  // bMax: 描画済み建物の総数上限。【2026-07-16】東京駅・標準で「静止→フル密度生成→浮上」で
  // クラッシュする問題の最終対策。実測でgeometries 21k(地上・安定)→51k(生成完了後)まで
  // 増え続けてGPUメモリが2GB→6GBに達していた。距離だけでは密集地の総量を制御できないため、
  // 総数で天井を切る(超過分はdormantに退避し、移動で近くの枠が空いたら復帰)。
  // minorRoadDist: 細街路(type='road'/'tertiary')のメッシュ化・保持距離。【2026-07-16】実測で
  // 東京駅・標準の道路メッシュが70,513本(geometries 5万超・GPU数GBの主因)に達していた。
  // 細街路は遠距離ではフォグでほぼ見えないため、主要道路(secondary以上・線路・川)より
  // 短い距離で切ってメッシュ総数を数分の一に抑える(レコード自体は残るのでミニマップ・
  // isOnRoad判定・再接近時の復元は従来どおり機能する)。
  lite: { roadUnload: 1600, bGenReal: 1400, bUnloadReal: 2000, chunkR: 4,  forestR: 360, prefetchR: 2, bMax: 6000,  minorRoadDist: 700 },
  std:  { roadUnload: 2500, bGenReal: 2200, bUnloadReal: 2900, chunkR: 8,  forestR: 480, prefetchR: 2, bMax: 12000, minorRoadDist: 1100 },
  high: { roadUnload: 3200, bGenReal: 3200, bUnloadReal: 4000, chunkR: 10, forestR: 600, prefetchR: 3, bMax: 25000, minorRoadDist: 1600 },
}[PERF_PRESET];
const ROAD_UNLOAD_DIST = PERF.roadUnload;
const MINOR_ROAD_MESH_DIST = PERF.minorRoadDist;
// 【2026-07-28・経路シムのクラッシュ対策】高架(motorway)も他の道路と同じくアンロード対象に
// するが、通常のROAD_UNLOAD_DISTよりずっと長い保持距離にする(遠くからでもスカイラインとして
// 見える高速道路が、普通に探索している範囲ではまず消えないようにするため)。経路シムのように
// 何十kmも一方向へ進み続けるケースでだけ、実際に距離アンロードが効いてGPUメモリを解放する。
const MOTORWAY_UNLOAD_DIST = ROAD_UNLOAD_DIST * 4;
// 【2026-07-20】未舗装(type:'unpaved'。part8.js参照)も細街路と同じ扱いにする。
// 舗装/未舗装で分岐する前は全て'road'だったため元々ここに含まれていた枠で、
// 分岐後にここを更新し忘れると農道・山道が幹線扱いの遠距離まで描画され続けてしまう。
const isMinorRoadType = (t) => t === 'road' || t === 'tertiary' || t === 'unpaved';
let _roadUnloadFrame = 0;
// force=true: 90フレーム周期を待たず即座に判定する(「今すぐ整理」ボタン用)
function unloadFarRoads(force) {
  if (!worldPosSettled) return; // 開始位置が確定するまで距離を根拠に捨てない(part1.js worldPosSettled参照)
  _roadUnloadFrame++;
  if (!force && _roadUnloadFrame % 90 !== 0) return; // 建物と同様、毎フレームやる必要はない(~1.5秒ごと)
  const px = player.position.x, pz = player.position.z;
  const d2 = ROAD_UNLOAD_DIST * ROAD_UNLOAD_DIST;
  const dMinor2 = MINOR_ROAD_MESH_DIST * MINOR_ROAD_MESH_DIST;
  const dMotorway2 = MOTORWAY_UNLOAD_DIST * MOTORWAY_UNLOAD_DIST;
  for (const r of roadRecords) {
    const mx = (r.x1 + r.x2) / 2, mz = (r.z1 + r.z2) / 2;
    const dx = mx - px, dz = mz - pz;
    const dd = dx * dx + dz * dz;
    // 【2026-07-28】高架(motorway)も対象に含める(理由は上のMOTORWAY_UNLOAD_DIST参照)。
    // ただし他の道路よりずっと長い距離まで保持する。
    const lim2r = r.type === 'motorway' ? dMotorway2 : isMinorRoadType(r.type) ? dMinor2 : d2;
    // 【2026-07-16】範囲内なのにメッシュが無い道路はここで再キューして復元する。
    // 以前はチャンク再生成(960m)頼みだったため、細街路の保持距離(1100m)との間に
    // 「再接近しても細い道路が生成されない帯」ができていた(実機報告)。
    // 【2026-08-03追加】メッシュは既にあるが`_dirty=true`(=作り直し待ちのまま距離チェックで
    // 握りつぶされていた。processRoadMeshQueue参照)の道路も、範囲内に戻ってきたタイミングで
    // ここで拾い直す。これが無いと「橋が水面より先に構築され、後から水面が届いて
    // _dirty=trueになったのに、遠方だったせいで永久に反映されない」不具合の対になる修正
    // (IMPL_PROMPT_20260803_BRIDGE_WATER.md M1)。
    if (!r.mesh || r._dirty) {
      if (dd <= lim2r) queueRoadMesh(r);
      continue;
    }
    if (dd <= lim2r) continue; // まだ範囲内(細街路は短い距離で切る)
    scene.remove(r.mesh);
    r.mesh.geometry.dispose();
    r.mesh = null;
    if (r.railWhite) {
      scene.remove(r.railWhite);
      r.railWhite.geometry.dispose();
      r.railWhite = null;
    }
  }
}

// ======= 道路レコードの距離アンロード =======
// 【2026-07-28・2回目の実測([mem]計器)で判明した本命】
// dormantの距離破棄を入れた後の走行ログでは、dormantは1500〜9000で振動して落ち着き、
// geo(約19000)・tex(約890)・heapMBも頭打ち/振動になった。その中で唯一きれいに単調増加して
// いたのが roadRec(= roadRecords.length)で、86,537 → 193,476 まで伸び、末尾では2秒あたり
// +13,000(≒6,500件/秒)のペースだった。10分走れば数百万件に達する計算で、レンダラ側の
// 800MB超という実測値とも桁が合う。
//
// 原因はdormantと同じ構造。unloadFarRoads は r.mesh を破棄してnullにするだけで、
// roadRecords 配列と roadGrid(40m四方の空間ハッシュ。1本の線分が複数セルに登録される)から
// レコードそのものを消す処理はどこにも無い。「軽量データは永久保持・GPUリソースだけ距離で
// 解放」という既存方針そのものだが、経路シムは無人で何十kmも走るためこの前提が崩れる。
// (さらにunloadFarRoadsは1.5秒ごとにroadRecords全件を走査するので、件数の増加はメモリ
//  だけでなくCPUコストにも効いてくる。)
//
// 対策: 十分遠い道路はレコードごと捨てる。距離はメッシュの保持距離より外側に取り、
// 「まだ描画されている・すぐ引き返せる」ものは絶対に捨てない。
// 【トレードオフ】捨てた範囲へ引き返すと、そのタイルは取得済み扱いのままなので道路が
// 復活しない(地形は残る)。KEEP距離は通常の探索範囲のはるか外なので実用上は起きないが、
// 経路シムで10km以上走ってから戻ると起こりうる。クラッシュより軽い劣化として許容する。
const ROAD_RECORD_KEEP_DIST = Math.max(6000, ROAD_UNLOAD_DIST * 2);
// 高架は遠景のスカイラインとしてMOTORWAY_UNLOAD_DISTまでメッシュを保持するので、
// レコードはそれより確実に外側まで残す(でないと保持距離内なのに復元できなくなる)。
const ROAD_RECORD_KEEP_DIST_MOTORWAY = MOTORWAY_UNLOAD_DIST * 1.3;
const ROAD_RECORD_SOFT_MIN = 20000; // これ以下なら走査自体しない(通常プレイでは常にここで抜ける)
let _roadEvictFrame = 0;
let _roadEvicted = 0; // [mem]ログ用(直近ウィンドウの累計)
function evictFarRoads(force) {
  if (!worldPosSettled) return; // 開始位置が確定するまで距離を根拠に捨てない(part1.js worldPosSettled参照)
  _roadEvictFrame++;
  if (!force && _roadEvictFrame % 300 !== 0) return; // ~5秒ごと(全件走査+グリッド再構築なので低頻度)
  if (roadRecords.length < ROAD_RECORD_SOFT_MIN) return;
  const px = player.position.x, pz = player.position.z;
  const keep2 = ROAD_RECORD_KEEP_DIST * ROAD_RECORD_KEEP_DIST;
  const keepMtw2 = ROAD_RECORD_KEEP_DIST_MOTORWAY * ROAD_RECORD_KEEP_DIST_MOTORWAY;
  let w = 0; // 生存分を前詰めするコンパクション(spliceの繰り返しを避ける)
  // 【2026-07-28】どのタイルが「全滅した」かを同じ1パスで数える。全滅したタイルだけは
  // 取得済みフラグを落として再取得可能に戻す(1本でも生き残っていると再取得で二重生成に
  // なるため、生存0のタイルに限る)。この距離(6000m超)では建物もdormantも既に消えている
  // ので、道路の全滅=そのタイルには何も残っていない、と見なせる。
  const _tileSurv = new Map(), _tileDropped = new Set();
  // 【2026-08-03・修正A】widが複数タイルにまたがりうるようになったため、「このタイルの
  // セグメントが全滅したか」に加えて「このwayは(タイルを問わず)どこかにまだ生き残って
  // いるか」も同じ1パスで数える。全滅タイルのway一覧をun-seeする際、まだ他所で生きている
  // wayを誤ってun-seeすると再取得で重複生成するため、resetTileForRefetchへprotectedWidsとして渡す。
  const _survivingWids = new Set();
  for (let i = 0; i < roadRecords.length; i++) {
    const r = roadRecords[i];
    const mx = (r.x1 + r.x2) / 2 - px, mz = (r.z1 + r.z2) / 2 - pz;
    const _tk = osmTileKeyOfXZ((r.x1 + r.x2) / 2, (r.z1 + r.z2) / 2);
    if (mx * mx + mz * mz <= (r.type === 'motorway' ? keepMtw2 : keep2)) {
      _tileSurv.set(_tk, (_tileSurv.get(_tk) || 0) + 1);
      if (r.wid != null) _survivingWids.add(r.wid);
      roadRecords[w++] = r; continue;
    }
    _tileDropped.add(_tk);
    // ここに来る時点でunloadFarRoadsが既にメッシュを解放しているはずだが、念のため。
    if (r.mesh) { scene.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh = null; }
    if (r.railWhite) { scene.remove(r.railWhite); r.railWhite.geometry.dispose(); r.railWhite = null; }
    // pendingRoadMeshes に既に積まれている参照はここでは消せない(配列の途中を突くのは高コスト)。
    // 代わりに印を付けておき、processRoadMeshQueue / queueRoadMesh 側で無視させる。
    r._dropped = true;
    _roadEvicted++;
  }
  if (w === roadRecords.length) return;
  roadRecords.length = w;
  for (const tk of _tileDropped) {
    if (!_tileSurv.get(tk)) dropTileRemnants(tk, _survivingWids); // 残りかす(dormant等)も消してから取得済みフラグを落とす。他所で生存中のwayはun-seeしない
  }
  // roadGridは1レコードが複数セルに入るため個別削除が面倒かつ高コスト。生存分だけで作り直す
  // (5秒に1回・生存数万件のO(n)なので、部分削除より単純で確実)。
  roadGrid.clear();
  for (const r of roadRecords) roadGridAdd(r);
}

// 矩形範囲(ワールド座標)にかかる道路を、現在の地形に合わせてまとめて再構築する。
function rebuildRoadsInBounds(x0, x1, z0, z1) {
  const gx0 = Math.floor(x0 / ROAD_CELL), gx1 = Math.floor(x1 / ROAD_CELL);
  const gz0 = Math.floor(z0 / ROAD_CELL), gz1 = Math.floor(z1 / ROAD_CELL);
  const seen = new Set();
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = roadGrid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const r of arr) {
      if (seen.has(r)) continue;
      seen.add(r);
      // 同期一括再構築(数百〜数千本)はNEAR更新のたびに大きなカクつきを生んでいたため、
      // フレーム分割キューに回す。_dirty=trueで「メッシュ生成済みでも作り直す」指定。
      r._dirty = true;
      queueRoadMesh(r);
    }
  }
}

// プレイヤー近くのチャンクが生成される(=このあたりの地形が最新・最高解像度で
// 揃っている)たびに呼び、そのチャンクにかかる道路だけ現在の地形に合わせて再構築する。
function rebuildRoadsNearChunk(chunkX, chunkZ) {
  const margin = 20; // 道幅ぶんの余裕
  const x0 = chunkX * CHUNK_SIZE - margin, x1 = chunkX * CHUNK_SIZE + CHUNK_SIZE + margin;
  const z0 = chunkZ * CHUNK_SIZE - margin, z1 = chunkZ * CHUNK_SIZE + CHUNK_SIZE + margin;
  rebuildRoadsInBounds(x0, x1, z0, z1);
  rebuildStationsInBounds(x0, x1, z0, z1); // 駅もY方向だけ地形に合わせて追従させる
  rebuildAreaPolysInBounds(x0, x1, z0, z1); // 川・公園・田畑ポリゴンも同じタイミングで合わせ直す
  rebuildBuildingsInBounds(x0, x1, z0, z1); // 建物もY方向だけ地形に合わせて追従させる
}
// 【2026-07-17】distSqPointToSegはjs/lib/pure.jsへ移動(CODE_REVIEW_20260717 P13-1)。
// 点(x,z)が、道路の中心線から (道幅/2 + extra) 以内にあるか(近傍セルだけ調べる)
function roadNear(x, z, extra) {
  const gx = Math.floor(x / ROAD_CELL), gz = Math.floor(z / ROAD_CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const arr = roadGrid.get((gx + dx) + ',' + (gz + dz));
    if (!arr) continue;
    for (const r of arr) {
      const d2 = distSqPointToSeg(x, z, r.x1, r.z1, r.x2, r.z2);
      const lim = (r.rw || 4) / 2 + extra;
      if (d2 < lim * lim) return true;
    }
  }
  return false;
}
// ======= 建物の高さresnap(地形更新への追従) =======
// 建物は道路と違い「壁+屋根+屋上設備+ライト」等の複数メッシュが絶対Y座標で
// 直置きされた剛体の集合。地形が変わっても形状自体は変えず、束ねて
// Y方向にだけ平行移動すれば大部分の浮き/埋まりは解消できる(道路のような
// ジオメトリ全再構築は不要)。ただし建物フットプリント内で傾斜が大きく
// 変化した場合は一律シフトだけでは片側だけ残ることがある(既知の限界。
// まずはこの方式で様子を見て、必要なら角ごとの微傾斜補正を検討する)。
const buildingRecords = []; // {x,z,w,d,h,style,gy,parts:[mesh/light,...],cbox,ck,bid}
let _buildingIdSeq = 0; // collisionBoxes/minimapBuildings/placedBuildingsから一括削除するための共通ID
const BUILDING_CELL = 80;
let meshedBuildingGrid = new Map();
// 共通のセル格子への登録処理(meshedBuildingGrid/realBuildingIndexで共有)
function _gridAddTo(grid, rec) {
  const pad = Math.max(rec.w, rec.d) / 2 + 5;
  const gx0 = Math.floor((rec.x - pad) / BUILDING_CELL), gx1 = Math.floor((rec.x + pad) / BUILDING_CELL);
  const gz0 = Math.floor((rec.z - pad) / BUILDING_CELL), gz1 = Math.floor((rec.z + pad) / BUILDING_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const k = gx + ',' + gz;
    let arr = grid.get(k);
    if (!arr) { arr = []; grid.set(k, arr); }
    arr.push(rec);
  }
}
// 【重要・2026-07-15】meshedBuildingGridは「実際にaddBuilding()でメッシュ化済みの建物」専用
// (rebuildBuildingsInBounds/rebuildBuildingHeightがparts/gyを前提に地形追従の平行移動を行う)。
// 一方hasRealBuildingNearby/hasRealHouseNearbyは「キューに積んだ時点(まだ未描画)」でも
// 本物のOSM建物の存在を知りたい([[project_isehara_game_procedural_infill_race]]参照)。
// 同じmeshedBuildingGridに未描画のスタブ(parts/gy無し)を混ぜてしまうと、rebuildBuildingHeightが
// rec.partsをiterateしようとして "rec.parts is not iterable" で例外になる不具合が起きた
// (実機で確認)。描画済み専用のmeshedBuildingGridとは別に、未描画スタブ専用のrealBuildingIndexを
// 用意し、用途を完全に分離する。
let realBuildingIndex = new Map();
function meshedBuildingGridAdd(rec) { _gridAddTo(meshedBuildingGrid, rec); }
function realBuildingIndexAdd(rec) { _gridAddTo(realBuildingIndex, rec); }
function rebuildBuildingGrid() {
  meshedBuildingGrid = new Map();
  for (const rec of buildingRecords) meshedBuildingGridAdd(rec);
}
// 1棟ぶんを現在の地形に合わせてY方向へ平行移動する(形状・ジオメトリは変えない)
function rebuildBuildingHeight(rec) {
  const hs = [
    getGroundY(rec.x, rec.z),
    getGroundY(rec.x - rec.w/2, rec.z - rec.d/2), getGroundY(rec.x + rec.w/2, rec.z - rec.d/2),
    getGroundY(rec.x - rec.w/2, rec.z + rec.d/2), getGroundY(rec.x + rec.w/2, rec.z + rec.d/2),
  ];
  const newGy = Math.min(...hs);
  const delta = newGy - rec.gy;
  if (Math.abs(delta) < 0.05) return; // 誤差レベルは無視(毎回全建物を動かさない)
  for (const p of rec.parts) { if (p) p.position.y += delta; }
  if (rec.cbox) { rec.cbox.min.y += delta; rec.cbox.max.y += delta; }
  rec.gy = newGy;
}
// 矩形範囲(ワールド座標)にかかる建物を、現在の地形に合わせてまとめて追従させる。
// 道路のrebuildRoadsInBoundsと同じタイミング(NEAR再取得時・チャンク生成時)で呼ぶ。
function rebuildBuildingsInBounds(x0, x1, z0, z1) {
  const gx0 = Math.floor(x0 / BUILDING_CELL), gx1 = Math.floor(x1 / BUILDING_CELL);
  const gz0 = Math.floor(z0 / BUILDING_CELL), gz1 = Math.floor(z1 / BUILDING_CELL);
  const seen = new Set();
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = meshedBuildingGrid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const rec of arr) {
      if (seen.has(rec)) continue;
      seen.add(rec);
      rebuildBuildingHeight(rec);
    }
  }
}

// 【重要】実OSM建物(タイル取得・初期ロード由来)は、手続き生成のチャンク建物と違って
// 一度生成されると距離に関係なく永久にscene・collisionBoxes等に残り続けていた。
// 探索範囲が広がるほど建物数が際限なく増え、最終的に描画・メモリが持たずに
// 「移動を続けると徐々に重くなり落ちる」症状になっていた。
// ここでプレイヤーから一定距離を超えた実建物のTHREE.jsオブジェクトを解放する。
// ただし完全に忘れるのではなく、軽量な記述(x,z,w,d,h,style)だけdormantBuildingsへ
// 戻しておき、再接近時にreactivateNearbyDormantBuildingsが検知してpendingBuildingsへ
// 戻し、通常の経路でまた生成されるようにする(手続き生成建物のチャンク・アンロード/
// 再生成と同じ考え方)。
//
// 遠景最適化(2026-07-15): 「道路・線路・川・地形さえ見えれば遠景としては十分」という
// 判断で、実建物だけ道路(ROAD_UNLOAD_DIST=2500m)よりずっと近い距離で足切りする。
// BUILDING_GEN_DIST(生成しはじめる距離)とBUILDING_UNLOAD_DIST(消す距離)を分け、
// 境界付近を行ったり来たりしても毎フレーム生成/消去を繰り返さないようにする
// (よくあるヒステリシス方式。差が無いと境界線上でチラつく)。
// UNLOAD側は当初1000mだったが、GEN(800m)との差が小さく、少し斜めに歩いただけでも
// 頻繁に解放→再生成を繰り返しがちだったため1500mに広げ、ヒステリシス帯を厚くした。
// 【2026-07-16】種類別の距離に分離(ユーザー要望):
// ・実OSM建物(real=マップデータ由来) = 3000mで生成 / 3800mで消去
// ・手続き生成建物(real=false)はチャンクシステム側(CHUNK_RADIUS)が約1000mを管理
// ヒステリシス帯(GEN<UNLOAD)は従来同様、境界往復でのチラつき防止。
// 数値はPERFプリセット(パフォーマンス設定)から取得
const BUILDING_GEN_DIST_REAL = PERF.bGenReal;
const BUILDING_UNLOAD_DIST_REAL = PERF.bUnloadReal;
const BUILDING_GEN_DIST_PROC = 1000;
const BUILDING_UNLOAD_DIST_PROC = 1800;
let _buildingUnloadFrame = 0;
// 【2026-07-21・Fable5診断】eviction(このすぐ下)が直近で実際に適用した実建物の保持距離。
// reactivateNearbyDormantBuildings側がこれを参照してマージン(境界の緩衝帯)を作る
// (evict/revive境界のチャタリング防止。詳細はreactivateNearbyDormantBuildings参照)。
let _lastRealKeepDist = BUILDING_UNLOAD_DIST_REAL;
// 【2026-07-21・Fable5診断: revive/evictスワップ結合】このサイクル(unloadFarBuildings)で
// 実際にbuildingRecordsから除去した件数。reactivateNearbyDormantBuildingsが同じ90フレーム
// 周期で直後に読み、REVIVE_BUDGETに加算する(evictが活発な瞬間ほどreviveも動けるようにし、
// records=bMax*0.95ちょうどで両者が釣り合って膠着する「アトラクタ」を構造的に解消する)。
let _freedThisCycle = 0;
// force=true: 90フレーム周期を待たず即座に判定する(「今すぐ整理」ボタン用。CODE_REVIEW P8関連)
function unloadFarBuildings(force) {
  if (!worldPosSettled) return; // 開始位置が確定するまで距離を根拠に捨てない(part1.js worldPosSettled参照)
  _buildingUnloadFrame++;
  if (!force && _buildingUnloadFrame % 90 !== 0) return; // 毎フレームやる必要はない(~1.5秒ごと)
  if (buildingRecords.length === 0) return;
  const px = player.position.x, pz = player.position.z;
  // 【2026-07-16】総数上限(PERF.bMax)付近では、実建物の消去距離をヒステリシス上限
  // (2900m)ではなく生成距離(2200m)まで詰める。上限到達中は「移動先の新しい建物」が
  // dormant行きになる一方、後方の建物が2900mを超えるまで枠が空かず、移動先の道路沿いに
  // 建物が建たない「枠詰まり」が起きていた(実機報告: 高所移動で拡張した道路に建物なし)。
  // 上限に余裕がある通常時は従来のヒステリシスでチラつきを防ぐ。
  const _nearCap = buildingRecords.length >= PERF.bMax * 0.95;
  const _realLim = _nearCap ? BUILDING_GEN_DIST_REAL : BUILDING_UNLOAD_DIST_REAL;
  let d2Real = _realLim * _realLim;
  // 【2026-07-16】上限到達中の「空洞化」対策。消去距離を生成距離まで詰めるだけでは、
  // 古い方向の1500〜2200m帯の建物が枠を占有し続け、足元の新着建物が枠待ちになって
  // 「遠くは建っているのに手前が空洞」になる瞬間があった(実機報告)。上限到達中は
  // 距離ヒストグラムで「近い順にbMaxの85%が収まる半径」を求め、それより外を解放する。
  // = どんな密集地でも常に「プレイヤーに近い建物が最優先で描画枠を得る」ことを保証する。
  if (_nearCap) {
    const BIN = 100, NBIN = 40; // 100m刻み×4km
    const hist = new Array(NBIN).fill(0);
    let realTotal = 0, procTotal = 0;
    for (const rec of buildingRecords) {
      if (!rec.real) { procTotal++; continue; }
      realTotal++;
      const dx = rec.x - px, dz = rec.z - pz;
      // 高層(40m超)は距離を1.6で割って「近い扱い」にし、選別で生き残りやすくする
      // (上限到達で保持半径が縮んでも、遠景のスカイラインが丸ごと消えないように)
      const dist = Math.sqrt(dx * dx + dz * dz) / (rec.h > 40 ? 1.6 : 1);
      const bi = Math.min(NBIN - 1, (dist / BIN) | 0);
      hist[bi]++;
    }
    // 【2026-07-21・Fable5診断・修正6】以前はtarget=PERF.bMax*0.85(=総数基準)だったが、
    // histは実建物しか数えていない。密集地でも実建物数がtarget未満の場合(手続き生成建物が
    // 総数の一部を占めるケース)、累積(acc)が一度もtargetへ到達できずcutoff=NBIN固定
    // (=このヒストグラム縮小自体が完全に空振り)になっていた。上限到達中でも実質的な
    // eviction(枠の解放)が一切発生せず、reactivateNearbyDormantBuildings側は855行目の
    // ガードで動かないため、dormantBuildingsが際限なく積み上がる片道弁の直接原因になっていた
    // (実機ログでrecords 12000/12000に張り付いたままdormantが11万件超まで増加して確認)。
    // 実建物のみのヒストグラムには実建物基準のtargetを使う: 「全体の85%からプロシージャル
    // 建物ぶんを差し引いた、実建物が占めてよい席数」。procTotalは他の距離カットオフ
    // (BUILDING_UNLOAD_DIST_PROC)で別途管理されるためここでは触らない。
    const target = Math.max(0, PERF.bMax * 0.85 - procTotal);
    let acc = 0, cutoff = NBIN;
    for (let i = 0; i < NBIN; i++) { acc += hist[i]; if (acc >= target) { cutoff = i + 1; break; } }
    const cutR = cutoff * BIN;
    if (cutR * cutR < d2Real) d2Real = cutR * cutR;
  }
  _lastRealKeepDist = Math.sqrt(d2Real); // reactivateNearbyDormantBuildings側のマージン計算用
  const d2Proc = BUILDING_UNLOAD_DIST_PROC * BUILDING_UNLOAD_DIST_PROC;
  const removeIds = new Set();
  // 【2026-07-17・P3】以前はここでbuildingRecordsを直接spliceしていたが、削除の6点セットを
  // removeBuildingsByIdsに集約したため、このループはremoveIds収集とTHREE.js解放・dormant退避
  // だけを行い、buildingRecords本体の除去はremoveBuildingsByIds側にまとめて任せる。
  for (const rec of buildingRecords) {
    const dx = rec.x - px, dz = rec.z - pz;
    let dd = dx * dx + dz * dz;
    if (rec.real && rec.h > 40) dd /= 2.56; // 高層は1.6倍遠くまで保持(ヒストグラムの換算と一致させる)
    if (dd <= (rec.real ? d2Real : d2Proc)) continue; // まだ範囲内
    for (const p of rec.parts) {
      if (!p || p.userData._released) continue; // 【2026-07-20・二重解放バグ修正】下記コメント参照
      p.userData._released = true;
      scene.remove(p);
      if (p.geometry && !p.geometry.userData.shared) p.geometry.dispose();
      if (p.material) releaseFacadeMat(p.material); // facadeMat以外は無害なno-op(part2.js参照)
    }
    removeIds.add(rec.bid);
    // 再接近時に復元できるよう、軽量な記述だけdormantBuildingsへ(すでに
    // BUILDING_UNLOAD_DIST > BUILDING_GEN_DIST の外なので、そのままpendingBuildingsへ
    // 戻すと次のフレームで即dormantへ送り返されるだけの無駄が発生する)。
    dormantAdd({ x: rec.x, z: rec.z, w: rec.w, d: rec.d, h: rec.h, style: rec.style, real: rec.real, rot: rec.rot });
  }
  _freedThisCycle = removeIds.size; // 【2026-07-21・Fable5診断】このサイクルの実解放件数を記録
  _bgEvicted += removeIds.size; // part9.js側の[buildgen]ログ用(2秒累計、ヒストグラム縮小の発火確認)
  removeBuildingsByIds(removeIds);
}

// (2026-07-16: ここにあった旧・高度LOD(updateAltitudeLOD)は撤去。上空で遠くの低層を非表示に
//  する対策だったが、条件を40m/300mまで絞ってもクラッシュ防止に効かないことが実測で判明。
//  真因は建物+道路メッシュの総量で、建物総数キャップ(PERF.bMax)+細街路メッシュ距離制限が
//  実際に効いた対策。経緯はDEBUG_SESSION_20260716_BUILDINGS.md参照)
// (2026-07-24: みなとみらいでのスマホ処理落ち対策として、上記と同種の「上空の遠景低層を
//  間引く」仕組み(updateFarLowriseCull)を再導入したが、視界回転(高度に関わらず密集方向を
//  向いた時)には効かず、風景が寂しくなる副作用だけがあったためユーザー要望で撤去。
//  処理落ちの根本原因はドローコール数(建物・道路の個別メッシュ)で、対策は別途検討する)
// dormantBuildings(遠すぎて未生成、または遠方で解放済みの実建物)を低頻度でスキャンし、
// プレイヤーがBUILDING_GEN_DIST以内に近づいたものだけpendingBuildingsへ戻して
// 通常の生成キューに合流させる。unloadFarBuildingsと同じ頻度(~1.5秒ごと)で十分
// (境界を跨いだ直後1.5秒以内に生成されれば体感上ポップインは気にならない)。
let _dormantCheckFrame = 0;
function reactivateNearbyDormantBuildings() {
  if (!worldPosSettled) return; // 開始位置が確定するまで距離を根拠に捨てない(part1.js worldPosSettled参照)
  _dormantCheckFrame++;
  if (_dormantCheckFrame % 90 !== 0) return;
  if (dormantCount === 0) return;
  // 総数上限(PERF.bMax)到達中は復帰させない(復帰→上限で即dormant戻しの空回り防止)
  if (buildingRecords.length >= PERF.bMax) return;
  const px = player.position.x, pz = player.position.z;
  // 【2026-07-21・Fable5診断(v2)】密集地(東京駅等)では既知の実建物数がbMaxを大きく
  // 超えるため、records(=buildingRecords.length)がbMax付近(80%超)に恒常的に張り付き
  // 続けるのが構造的な必然であり、「過渡的な回復中」と「定常的な高止まり」を閾値で
  // 区別しようとした前回の設計(80%未満=無制限、80%以上=200件固定)は、密集地では
  // 実質「常に200件/サイクル(≈133件/秒)」に固定されているのと同じになってしまい、
  // dormant数万件規模の復帰が追いつかず新たなボトルネックになった(実機ログで確認: 特定
  // タイルのbuildPendingが10秒以上一切減らないまま固定)。閾値によるレジーム切り替え自体を
  // やめ、「修正6のヒストグラム縮小(85%まで空ける)と対になる、今空いている容量ぶんだけ」
  // を予算にする。空きが無ければ0、大きく空いていれば(上限復帰直後等)それに応じて多く
  // 復帰できる、雪崩スパイクは構造的に起きない(空き以上には入れられないため)。
  // 実際のメッシュ生成コストは下流(exploreOnUpdateの_buildFrameDeadline=8ms)が
  // 別途守っているので、ここでの上限緩和が直接フレーム落ちにつながることはない。
  // 【2026-07-21・Fable5診断(v3): records=95%アトラクタでの膠着対策】上の空き枠
  // (headroom)だけだと、evict(unloadFarBuildings)とrevive(このサイクル)の出入りが
  // 釣り合ってrecordsがbMax*0.95ちょうどで静止する均衡点(アトラクタ)に捕まった瞬間、
  // headroom=0で復帰が完全停止する(実機ログで確認: dormant急増中にrevived/2sが600→8)。
  // 直前(同じ90フレーム周期)にunloadFarBuildingsが実際に解放した件数(_freedThisCycle)を
  // 加算することで、evictが活発な瞬間ほどreviveも動けるようにし、膠着を構造的に防ぐ。
  // 下限30/サイクル(≈20件/秒)はevictも完全停止している場合の最終保険(bMaxの0.25%程度
  // なので雪崩にはならない)。総数超過はpart9側の最終弁(records>=bMaxでdormant退避)が
  // 別途守るため、多少の見積もり超過があっても安全。
  const headroom = Math.max(0, Math.floor(PERF.bMax * 0.95) - buildingRecords.length);
  const REVIVE_BUDGET = Math.min(600, Math.max(30, headroom + _freedThisCycle));
  // ヒステリシスマージン(evict境界とのチャタリング防止)は維持。
  const _nearCapNow = buildingRecords.length >= PERF.bMax * 0.95;
  const _realRevLim = _nearCapNow ? Math.min(BUILDING_GEN_DIST_REAL, _lastRealKeepDist * 0.8) : BUILDING_GEN_DIST_REAL;
  const d2Real = _realRevLim * _realRevLim;
  const d2Proc = BUILDING_GEN_DIST_PROC * BUILDING_GEN_DIST_PROC;
  // 【2026-07-21・Fable5診断(v2)】以前は配列の末尾(=直近dormant入りした建物)から走査
  // していたため、古くから待っている近傍建物に予算が永遠に回らない「LIFO飢餓」を
  // 起こしていた(レートを上げても解決しない選択の問題、と指摘された)。プレイヤーに
  // 近いセル(DORMANT_CELL=200m四方、part8.js)から外側へ順に走査し、常に「近い建物が
  // 最優先で復帰する」ことを保証する。
  const maxD = Math.sqrt(Math.max(d2Real, d2Proc));
  const maxR = Math.max(0, Math.ceil(maxD / DORMANT_CELL)) + 1;
  const pgx = Math.floor(px / DORMANT_CELL), pgz = Math.floor(pz / DORMANT_CELL);
  let revived = 0;
  for (let r = 0; r <= maxR && revived < REVIVE_BUDGET; r++) {
    for (let gx = pgx - r; gx <= pgx + r && revived < REVIVE_BUDGET; gx++) {
      for (let gz = pgz - r; gz <= pgz + r; gz++) {
        if (Math.max(Math.abs(gx - pgx), Math.abs(gz - pgz)) !== r) continue; // このリング(距離r)の外周セルだけ
        const arr = dormantGrid.get(gx + ',' + gz);
        if (!arr || arr.length === 0) continue;
        for (let i = arr.length - 1; i >= 0 && revived < REVIVE_BUDGET; i--) {
          const b = arr[i];
          const dx = b.x - px, dz = b.z - pz;
          let dd = dx * dx + dz * dz;
          // 【2026-07-21・Fable5診断】unloadFarBuildingsの高層優遇(÷1.6、距離の2乗なので
          // ÷2.56)と評価基準を揃える。揃っていないと高層建物だけevict/revive境界がずれて
          // チャーンしうる。
          if (b.real && b.h > 40) dd /= 2.56;
          if (dd <= (b.real ? d2Real : d2Proc)) {
            const last = arr.length - 1; // セル内はswap-remove(順序不要なのでO(1))
            arr[i] = arr[last]; arr.pop();
            dormantCount--;
            pendingBuildings.push(b);
            revived++;
            _bgRevived++; // 【2026-07-21・Fable5診断(dormant復帰)】part9.js側の[buildgen]ログ用
          }
        }
        if (arr.length === 0) dormantGrid.delete(gx + ',' + gz);
      }
    }
  }
}

// ======= dormantの距離アンロード =======
// 【2026-07-28・経路シムのクラッシュ実測(PC Chrome、[mem]計器)で判明】
// renderer.info の geometries(約18000)・textures(約1080)は数分走っても頭打ちになる一方、
// dormantCount だけが 0 → 22000 超へ単調増加し、末尾では toDormant/2s が 4000 件を超えて
// いた(evicted は数十〜数百件しかなく、revive はプレイヤー近傍セルしか対象にしない)。
// つまりGPU側はもう漏れておらず、際限なく増えるのは「軽量データは永久保持」という設計の
// dormantGrid だけ、というのが実測の結論。
// 通常のWASD探索では行動範囲が狭く問題化しなかったが、経路シムは無人で何十kmも一方向へ
// 進み続けるため、二度と戻らない土地の建物記述子を全部抱え続けることになる。
//
// 対策: プレイヤーから十分遠いセルは丸ごと捨てる。捨てる距離は道路のアンロード距離
// (ROAD_UNLOAD_DIST=2500m)より十分外側に取り、「まだ見えている・すぐ戻れる」範囲の
// 建物は絶対に捨てない。加えて総数の絶対上限も設け、上限超過時は遠いセルから落とす。
// 【トレードオフ】捨てたセルへ後から戻ると、そのタイルは取得済み扱いのままなので建物が
// 復活しない(地形・道路は残る)。KEEP距離を大きめに取っているので通常の探索では起きないが、
// 経路シムで数km走ってから引き返した場合は起こりうる。クラッシュより軽い劣化として許容する。
const DORMANT_KEEP_DIST = Math.max(4000, ROAD_UNLOAD_DIST * 1.6);
const DORMANT_MAX = 60000; // これを超えたら遠いセルから落とす(絶対上限)
let _dormantEvictFrame = 0;
let _dormantEvicted = 0; // [mem]ログ用(直近ウィンドウの累計)
function evictFarDormant() {
  _dormantEvictFrame++;
  if (_dormantEvictFrame % 90 !== 0) return; // unloadFarBuildingsと同じ周期
  if (!worldPosSettled) return; // 開始位置が確定する前の距離判定でdormantを恒久削除しない
  if (dormantCount === 0) return;
  const px = player.position.x, pz = player.position.z;
  const keep2 = DORMANT_KEEP_DIST * DORMANT_KEEP_DIST;
  // 第1段: KEEP距離の外のセルを捨てる。セル中心で判定(セルは200m四方なので誤差は無視できる)
  for (const [key, arr] of dormantGrid) {
    const c = key.split(','), cx = (+c[0] + 0.5) * DORMANT_CELL, cz = (+c[1] + 0.5) * DORMANT_CELL;
    const dx = cx - px, dz = cz - pz;
    if (dx * dx + dz * dz <= keep2) continue;
    dormantCount -= arr.length;
    _dormantEvicted += arr.length;
    for (const b of arr) markTileStale(b.x, b.z); // 再接近時に作り直せるよう印を付ける
    dormantGrid.delete(key);
  }
  // 第2段: それでも上限を超えている(=KEEP距離内が異常に密)場合、遠いセルから落として上限に収める
  if (dormantCount <= DORMANT_MAX) return;
  const cells = [];
  for (const [key, arr] of dormantGrid) {
    const c = key.split(','), cx = (+c[0] + 0.5) * DORMANT_CELL, cz = (+c[1] + 0.5) * DORMANT_CELL;
    const dx = cx - px, dz = cz - pz;
    cells.push({ key, n: arr.length, d2: dx * dx + dz * dz });
  }
  cells.sort((a, b) => b.d2 - a.d2); // 遠い順
  for (const c of cells) {
    if (dormantCount <= DORMANT_MAX) break;
    dormantCount -= c.n;
    _dormantEvicted += c.n;
    const arr2 = dormantGrid.get(c.key);
    if (arr2) for (const b of arr2) markTileStale(b.x, b.z); // 同上
    dormantGrid.delete(c.key);
  }
}

// ======= 【2026-07-28】恒久破棄したタイルの作り直し =======
// 距離アンロード(evictFarDormantの上限超過分など)で建物だけを捨てたタイルは、道路レコードが
// 生き残っているため上のevictFarRoadsの「全滅判定」には掛からない。放っておくと
// 「タイルは取得済み・道路はある・建物だけ永久に無い」状態が固定される(密集地では
// dormant上限60,000への張り付きで2秒あたり1〜2万件がここに落ちている)。
// プレイヤーが戻ってきたら、そのタイルの残存レコードを全部消してから取得済みフラグを落とし、
// 通常のタイル取得に拾わせて作り直す。
// 【距離の選び方】道路メッシュの表示距離(ROAD_UNLOAD_DIST)より外側で行う。手前でやると
// 目の前の道路が一度消えて再生成される(ちらつく)ため。
// 【2026-08-01・CODE_REVIEW_20260801 P0-1 の修正】以前は Math.max(5000, ROAD_UNLOAD_DIST*1.5)
// で、std/lite では DORMANT_KEEP_DIST(4000m)より【外側】になっていた。
//     lite: KEEP 4000 / REVIVE 5000 → 反転   std: KEEP 4000 / REVIVE 5000 → 反転
//     high: KEEP 5120 / REVIVE 5000 → 正常(たまたま)
// 「捨てる境界」より「作り直す境界」が外側にあると、捨てた瞬間に作り直し条件を満たす。
// しかも evictFarDormant と reviveStaleTiles はどちらも %90 で位相が一致するため、
// 同一フレームで「dormantを捨てる → stale印 → 道路レコード全削除 → 未取得へ戻す」まで
// 進み、直後の checkOSMTiles が再キューする。結果、先読み範囲(5x5の外周は3200〜4800m)の
// タイルが1.5秒周期で永久に取得・破棄を繰り返し、Overpassの同時実行枠を食い潰していた
// (ユーザー報告「足元より先に遠くのタイルが生成される」の主因)。
// 必ず KEEP の内側になるよう、両者を突き合わせて決める。ROAD_UNLOAD_DIST(道路メッシュの
// 表示距離)より外側という元々の条件も維持する(手前でやると目の前の道路がちらつくため)。
//     std 2800m / lite 1920m / high 3584m — いずれも road表示距離の外かつ KEEP の内側
const STALE_REVIVE_DIST = Math.min(DORMANT_KEEP_DIST * 0.7, ROAD_UNLOAD_DIST * 1.2);
// そのタイルに属する残存レコードを全部消してから、再取得可能な状態へ戻す。
// 【重要】resetTileForRefetchを単体で呼んではいけない(残存レコードがあると二重生成になる)。
function dropTileRemnants(tk, protectedWids) {
  // dormant: タイル内のセルを消す
  const parts = tk.split(',');
  const tx = parseInt(parts[0], 10), tz = parseInt(parts[1], 10);
  const c0x = Math.floor(tx * OSM_TILE_M / DORMANT_CELL), c1x = Math.ceil((tx + 1) * OSM_TILE_M / DORMANT_CELL);
  const c0z = Math.floor(tz * OSM_TILE_M / DORMANT_CELL), c1z = Math.ceil((tz + 1) * OSM_TILE_M / DORMANT_CELL);
  for (let gx = c0x; gx < c1x; gx++) for (let gz = c0z; gz < c1z; gz++) {
    const k = gx + ',' + gz;
    const arr = dormantGrid.get(k);
    if (!arr) continue;
    dormantCount -= arr.length;
    _dormantEvicted += arr.length;
    dormantGrid.delete(k);
  }
  // 面レコード(公園・水面・田畑・キャンパス/回避ポリゴン/土地利用)も落とす。
  // 残したまま再取得すると同じポリゴンが二重に積まれ、面メッシュが重なってz-fightingする。
  if (typeof dropAreaRecordsInTile === 'function') dropAreaRecordsInTile(tx, tz, OSM_TILE_M);
  resetTileForRefetch(tk, protectedWids);
}
let _staleReviveFrame = 0;
// 1回の作り直しで扱うタイル数の上限。下の処理は targets の件数に関わらず roadRecords 全件を
// 1パス走査 + roadGrid 全再構築するので、まとめてやるほど1回のコストは変わらず「回数」だけが
// 効く。近い順に少しずつ捌けば十分(次の周期=約5秒後に続きをやる)。
const STALE_REVIVE_MAX_PER_PASS = 4;
function reviveStaleTiles() {
  _staleReviveFrame++;
  // 【2026-08-01・CODE_REVIEW_20260801 P0-1 の修正(3)】以前は %90(約1.5秒)で、しかも
  // evictFarRoads にある ROAD_RECORD_SOFT_MIN 相当のガードが無かった。この関数は対象が
  // 1枚でもあれば roadRecords 全件走査 + roadGrid.clear()+全件再構築を行うため、経路シムで
  // レコードが数万〜十数万件に育った状態だと 1.5 秒ごとにその再構築が回っていた。
  // 全件走査+グリッド再構築という性質は evictFarRoads と同じなので、周期もそちらに揃える。
  // 【位相】%300 の余り 7 は %90 の 0 と決して一致しない(gcd(300,90)=30、7 は 30 の倍数で
  // ないため)。evictFarDormant(%90)と同一フレームに走らないようにして、「捨てた直後に
  // 作り直す」形になりにくくする(構造的な循環自体は markTileStale の距離ガードで断ち済み。
  // これは二重の保険)。
  if (_staleReviveFrame % 300 !== 7) return;
  if (!worldPosSettled || staleTiles.size === 0) return;
  const px = player.position.x, pz = player.position.z;
  const lim2 = STALE_REVIVE_DIST * STALE_REVIVE_DIST;
  // 近い順に上限件数だけ拾う(遠いものが先に枠を取って、目の前のタイルが後回しに
  // なるのを防ぐ)。
  const cand = [];
  for (const tk of staleTiles) {
    const p2 = tk.split(',');
    const cx = (parseInt(p2[0], 10) + 0.5) * OSM_TILE_M, cz = (parseInt(p2[1], 10) + 0.5) * OSM_TILE_M;
    const dx = cx - px, dz = cz - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 <= lim2) cand.push({ tk, d2 });
  }
  if (cand.length === 0) return;
  cand.sort((a, b) => a.d2 - b.d2);
  const targets = new Set();
  for (let i = 0; i < Math.min(STALE_REVIVE_MAX_PER_PASS, cand.length); i++) targets.add(cand[i].tk);
  // 【2026-08-03・修正A】以前は「セグメント中点がtargetsタイルの範囲内か」という位置ベースで
  // 削除対象を決めていた。しかしそのwayが実際に帰属するタイル(tileWays、複数タイルに
  // またがりうる)と、セグメントの位置(タイル1つに定まる)は一致しない場合がある——特に
  // 線路・幹線道路のような長いwayは、帰属タイルの外に伸びるセグメントを大量に持つ。
  // 位置ベースのままだと、un-seeされたway(帰属タイル側で判定)のうち帰属タイルの外に
  // あるセグメントだけ消し忘れ、再取得時にそのway全体が新規追加されて古いセグメントと
  // 重複する。widベース(そのwayが生成した全セグメントを、位置を問わず一括削除)に統一する。
  const widSet = new Set();
  for (const tk of targets) {
    const ways = tileWays.get(tk);
    if (ways) for (const id of ways) widSet.add(id);
  }
  // 【2026-08-03・修正P2(v3 perf)】widベース削除は「そのwayが生成した全セグメント」を
  // 位置を問わず消すため、遠方タイル1枚がstaleになるたびに、そのwayが足元まで伸びていれば
  // 近くの道路・線路まで巻き込んで一度消え、再取得・再メッシュされていた(体感「道路の
  // 生成がいつまでも安定しない」の原因。2026-08-01に潰した距離ラダー反転と構造的に同じ罠。
  // IMPL_PROMPT_20260803_ROAD_FIDELITY_v3_PERF.md参照)。evictFarRoadsの_survivingWidsと
  // 同じ発想で、近傍(ROAD_UNLOAD_DIST以内)に生存セグメントを持つwayは削除対象からも
  // un-see対象からも外す(目の前で描画中の道路は絶対に触らない。そのタイル区間は、
  // このwayがプレイヤーから離れた時に改めて作り直される)。
  const nearLim2 = ROAD_UNLOAD_DIST * ROAD_UNLOAD_DIST;
  const nearWids = new Set();
  for (const r of roadRecords) {
    if (r.wid == null || !widSet.has(r.wid)) continue;
    const mx = (r.x1 + r.x2) / 2 - px, mz = (r.z1 + r.z2) / 2 - pz;
    if (mx * mx + mz * mz <= nearLim2) nearWids.add(r.wid);
  }
  for (const id of nearWids) widSet.delete(id);
  const dropped = removeRoadRecordsByWid(widSet);
  for (const tk of targets) dropTileRemnants(tk, nearWids);
  console.log('[staleTile] ' + targets.size + 'タイルを作り直します(way帰属の道路レコード' + dropped + '本を破棄して再取得、近傍生存' + nearWids.size + 'way保護)');
}

// ======= 【2026-07-21・Fable5診断(b)】ゲート待ち建物の隔離キュー =======
// 以前はchunkNearTerrainReady/osmTilesReadyAroundが不成立の建物を、1件ずつ「ダメなら末尾へ
// 戻す」方式で扱っていた(part9.js生成ループ)。密集地では地形NEARの網羅が建物到着に
// 追いつかない時間帯があり、この「末尾へ戻すだけ」の建物が生成予算の過半(実機計測で56%)を
// 空費する「requeued空回り」の直接原因になっていた(同じ建物群が0.5秒毎の距離再ソートで
// また先頭付近に戻ってきては、また同じ理由で末尾へ戻される、というタイトループ)。
// ゲート不成立の建物を「建物ごと」ではなく「ゲートのキー(チャンク/タイル)単位」で
// グループ化して退避し、90フレーム毎の低頻度スキャナがキー単位(密集地でも数十)で
// readyを再判定する(数万棟の毎フレーム走査 → 数十キーの間欠チェックに激減)。
const chunkWaitBuildings = new Map(); // "bcx,bcz" -> { arr: 建物[], tries: number }
const tileWaitBuildings = new Map();  // 建物自身の所属タイル"tx,tz" -> { arr: 建物[], tries: number }
function chunkWaitAdd(key, b) {
  let e = chunkWaitBuildings.get(key);
  if (!e) { e = { arr: [], tries: 0 }; chunkWaitBuildings.set(key, e); }
  e.arr.push(b);
}
function tileWaitAdd(key, b) {
  let e = tileWaitBuildings.get(key);
  if (!e) { e = { arr: [], tries: 0 }; tileWaitBuildings.set(key, e); }
  e.arr.push(b);
}
let _gateWaitScanFrame = 0;
function scanGateWaitQueues() {
  _gateWaitScanFrame++;
  if (_gateWaitScanFrame % 90 !== 0) return;
  if (chunkWaitBuildings.size === 0 && tileWaitBuildings.size === 0) return;
  const px = player.position.x, pz = player.position.z;
  const d2Real = BUILDING_GEN_DIST_REAL * BUILDING_GEN_DIST_REAL;
  // 【Fable5指摘・注意点】(1)隔離キューの建物もプレイヤーが離れたらdormantへ退避しないと、
  // 二度と戻れない待機列に永久に残り続ける。(2)戻す際は1サイクルあたりの件数に上限を設け、
  // 多数のキーが同時にreadyになった瞬間の雪崩(pendingBuildingsへの一括流入)を防ぐ。
  let returnBudget = 2000;
  const scanMap = (map, isReady) => {
    for (const [key, e] of map) {
      e.tries++;
      // 【2026-07-19由来・安全弁】20回(約30秒)試しても揃わなければ、諦めてFAR基準のまま
      // 生成する(無限に待ち続けるのを防ぐ。元の_tries<40の考え方を1キー単位に踏襲)。
      const ready = isReady(key, e) || e.tries >= 20;
      const keep = [];
      for (const b of e.arr) {
        const dx = b.x - px, dz = b.z - pz;
        if (b.real && dx * dx + dz * dz > d2Real) { dormantAdd(b); continue; } // 離れた分はdormantへ
        if (ready && returnBudget > 0) { pendingBuildings.push(b); returnBudget--; continue; }
        keep.push(b);
      }
      if (keep.length === 0) map.delete(key); else e.arr = keep;
    }
  };
  scanMap(chunkWaitBuildings, (key) => {
    if (IS_MEIJI) return true;
    const parts = key.split(',');
    return chunkNearTerrainReady(parseInt(parts[0], 10), parseInt(parts[1], 10));
  });
  scanMap(tileWaitBuildings, (key, e) => {
    const rep = e.arr[0];
    return !!rep && osmTilesReadyAround(rep.x, rep.z, 64);
  });
}
// ログ・デバッグオーバーレイ用: 隔離キュー内の総件数(呼び出し頻度が低い場所でのみ使う想定)
function gateWaitTotalCount() {
  let n = 0;
  for (const e of chunkWaitBuildings.values()) n += e.arr.length;
  for (const e of tileWaitBuildings.values()) n += e.arr.length;
  return n;
}

let placedBuildings = [];  // {x,z,r,ck} for landuse de-duplication
// 【2026-07-17・CODE_REVIEW_20260717 P1】hasBuildingNearbyはplacedBuildings全件を線形走査
// していた唯一残った「増え続ける配列の全件走査」ホットパス(generateChunkが1チャンクあたり
// 数百候補点で呼ぶため、bMax近くまで建物が溜まった密集地では1チャンク生成=数百万回の距離
// 計算になり得た)。meshedBuildingGrid/realBuildingIndexと同じBUILDING_CELLのセル格子に載せ替える。
// 判定ロジック(b.r込みの距離)自体は変えない。削除時はrebuildBuildingGrid等と同じ
// タイミングでrebuildPlacedBuildingsGrid()を呼び、同期を保つ。
let placedBuildingsGrid = new Map();
function placedBuildingsGridAdd(rec) {
  const pad = (rec.r || 0) + 5;
  const gx0 = Math.floor((rec.x - pad) / BUILDING_CELL), gx1 = Math.floor((rec.x + pad) / BUILDING_CELL);
  const gz0 = Math.floor((rec.z - pad) / BUILDING_CELL), gz1 = Math.floor((rec.z + pad) / BUILDING_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const k = gx + ',' + gz;
    let arr = placedBuildingsGrid.get(k);
    if (!arr) { arr = []; placedBuildingsGrid.set(k, arr); }
    arr.push(rec);
  }
}
function rebuildPlacedBuildingsGrid() {
  placedBuildingsGrid = new Map();
  for (const rec of placedBuildings) placedBuildingsGridAdd(rec);
}
// 建物1棟ぶんの削除で必ず一緒に触る「6点セット」を1関数に集約したもの。
// 【2026-07-17・CODE_REVIEW_20260717 P3】以前はremoveBuildingsOverlappingRoad(このファイル)・
// unloadFarBuildings(このファイル)・updateChunks(part8.js)の3箇所にほぼ同一コピペで存在し、
// 新しい属性・インデックスを足すたびに3箇所の同期漏れリスクがあった(過去の幽霊当たり判定・
// "rec.parts is not iterable"はこの分散が土壌)。
// 呼び出し元は先に「削除するbuildingのbid集合」を作り(判定基準は道路重なり/距離/chunkKeyなど
// 呼び出し元ごとに異なってよい)、THREE.jsオブジェクトの解放や再キュー(pendingBuildings/
// dormantBuildingsへ戻す等)を済ませてから、このremoveBuildingsByIdsを呼ぶ。
// collisionBoxes/minimapBuildings/placedBuildingsはいずれもbidを持つため、削除基準が
// chunkKey等であっても最終的にはbid集合に変換して渡せば同じ経路で削除できる。
function removeBuildingsByIds(removeIds) {
  if (!removeIds || removeIds.size === 0) return;
  for (let i = buildingRecords.length - 1; i >= 0; i--) {
    if (removeIds.has(buildingRecords[i].bid)) buildingRecords.splice(i, 1);
  }
  collisionBoxes = collisionBoxes.filter(b => !removeIds.has(b.buildingId));
  minimapBuildings = minimapBuildings.filter(b => !removeIds.has(b.bid));
  placedBuildings = placedBuildings.filter(b => !removeIds.has(b.bid));
  rebuildCollGrid();
  rebuildBuildingGrid();
  rebuildPlacedBuildingsGrid();
}
const landusePolygons = []; // {pts, lu, minX, maxX, minZ, maxZ} — stored during loadOSM for dynamic chunk generation
const landuseGrid = new Map(); // polyGridAdd/queryPolyGridで使う空間ハッシュ(全件走査を避ける)
const loadedChunks = new Set(); // "cx,cz" string keys of already-generated chunks
const chunkMeshes = new Map();  // "cx,cz" → [THREE.Mesh, ...] for unloading
const CHUNK_SIZE = 120;  // meters per chunk side
// 建物密度を大幅に上げた(ぎゅうぎゅうの日本の街並み)ため、生成半径は
// ±480m→±360mに縮小し、代わりにフォグを濃く(0.0004→0.00056)して
// ポップインが目立たない距離バランスを維持する。
// 【2026-07-16】ユーザー要望「手続き生成建物=約1000m」に合わせ 3→8(8×120=960m)。
// チャンク数は49→289に増えるが生成はフレーム分割キューなので徐々に埋まる。
// 重すぎる場合は6(720m)あたりに戻す候補。
// 【2026-07-25】以前は明治・江戸だけ「低密度だから」という理由でPERF.chunkRを無視し
// 固定4(480m)にしていたが、江戸切絵図の実データ統合や村落密度の引き上げで明治・江戸の
// 密度は現実モードに近づいたため、一旦PERF.chunkRへ統一した。
// 【2026-07-25再修正】ただしユーザーとの相談の結果、明治・江戸は実測建物なし・
// ファサードは共有キャッシュのみで中身自体は今も現実モードより軽いため、「フォグで
// どのみち霞んで見えなくなる距離」までは専用に伸ばしてよいことになった。フォグ密度
// (edo=0.00056, meiji=0.0004。WORLD_FOG定義参照)から「これ以上先は生成しても白く
// 霞むだけで意味がない」視認限界を逆算すると、edo≈2.7km・meiji≈3.8km。少し余裕を
// 持たせてedo 2.6km・meiji 3.4kmを上限とする。軽量プリセットは低スペック機向けの
// 安全策として現実モードと揃えたまま(勝手に重くしない)、標準・高品質だけ拡張する。
// 総建物数はPERF.bMaxで別途頭打ちになるため、範囲を広げても建物が際限なく増えはしない
// (広い範囲に薄く配置されるだけ)。チャンク数(=地面メッシュ生成コスト)は増えるが、
// 生成はフレーム分割キュー(chunkGenQueue)で徐々に埋まるため急な処理落ちにはなりにくい。
const EDO_MEIJI_CHUNK_DIST = {
  lite: { edo: 480,  meiji: 480  }, // 現実モード(lite)と同じ距離のまま
  std:  { edo: 1500, meiji: 1500 },
  high: { edo: 2600, meiji: 3400 },
};
const CHUNK_RADIUS = USES_MEIJI_LANDUSE
  ? Math.round(EDO_MEIJI_CHUNK_DIST[PERF_PRESET][MODE === 'edo' ? 'edo' : 'meiji'] / CHUNK_SIZE)
  : PERF.chunkR; // パフォーマンス設定に連動

// 【2026-07-17】pointInPolygonはjs/lib/pure.jsへ移動(CODE_REVIEW_20260717 P13-1)。

// 【重要】以前はminDist(=新しく置こうとしている側の半径+余白)だけを見ており、
// 既存の建物側の大きさ(b.r。placedBuildingsに元々記録済み)を一切考慮していなかった。
// そのため、マンションのような大きな実建物のすぐ隣(中心からの距離だけで見れば
// 十分離れているつもりでも、大きな建物自体の縁からは全く離れていない位置)にまで
// 手続き生成の小さな戸建てが並んでしまい、実際にはマンション1棟のはずの場所が
// 「戸建ての集まり」に見える不具合の一因になっていた。既存建物の半径ぶんも
// 足し合わせて判定する(=「建物の縁から」minDistだけ離れているかを見る)。
function hasBuildingNearby(cx, cz, minDist) {
  const gx0 = Math.floor((cx - minDist) / BUILDING_CELL), gx1 = Math.floor((cx + minDist) / BUILDING_CELL);
  const gz0 = Math.floor((cz - minDist) / BUILDING_CELL), gz1 = Math.floor((cz + minDist) / BUILDING_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = placedBuildingsGrid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const b of arr) {
      const dx = cx - b.x, dz = cz - b.z;
      const lim = minDist + (b.r || 0);
      if (dx*dx + dz*dz < lim*lim) return true;
    }
  }
  return false;
}

// 「本物のOSM建物」が近くに実在するか(手続き生成分は含まない)。
// 農地・山道の道グリッドを住宅街と誤認する対策(denseAreaの裏付け条件に使う)。
// 家並みが実在するエリアなら、landuseタグが無くても実OSM建物が既にいくつか立っている。
function hasRealBuildingNearby(cx, cz, dist) {
  const d2 = dist * dist;
  const gx0 = Math.floor((cx - dist) / BUILDING_CELL), gx1 = Math.floor((cx + dist) / BUILDING_CELL);
  const gz0 = Math.floor((cz - dist) / BUILDING_CELL), gz1 = Math.floor((cz + dist) / BUILDING_CELL);
  // realBuildingIndex: キュー投入時点(未描画でもよい)で「本物のOSM建物」として登録済みの
  // 軽量インデックス([[project_isehara_game_procedural_infill_race]]参照)。描画済み専用の
  // meshedBuildingGridとは別物なので混同しないこと。
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = realBuildingIndex.get(gx + ',' + gz);
    if (!arr) continue;
    for (const rec of arr) {
      if (!rec.real) continue;
      const dx = rec.x - cx, dz = rec.z - cz;
      if (dx*dx + dz*dz < d2) return true;
    }
  }
  return false;
}

// hasRealBuildingNearbyの「一戸建て限定」版。landuseタグが無い(=luTypeAtがnullを返す)
// 場所でも、近くの本物のOSM建物が工場(industrial)などの非住宅用途だと分かっていれば、
// それを一戸建て補完(buildable)の根拠にしない。landuse=industrialのポリゴンが
// 描かれていない工場・倉庫の構内でも一戸建てが誤って並ぶのを防ぐための追加ガード。
// 【重要】以前はindustrial/shopしか除外しておらず、apartment/office(マンション・オフィス。
// classifyResidentialでbuilding=yesの大型建物を正しく格上げできるようになった後に顕在化)
// が近くにあるだけで「本物の一戸建てが実在するエリア」と誤認され、大きなマンション/オフィス
// ビル1棟のすぐ周りまで手続き生成の戸建てが取り囲むように並んでしまっていた
// (実機報告: 「ジャンプ用マップには大きなマンションの枠があるのに、生成では戸建て
// 住宅の集まりになっている」)。マンション・オフィスも一戸建て補完の根拠から除外する。
function hasRealHouseNearby(cx, cz, dist) {
  const d2 = dist * dist;
  const gx0 = Math.floor((cx - dist) / BUILDING_CELL), gx1 = Math.floor((cx + dist) / BUILDING_CELL);
  const gz0 = Math.floor((cz - dist) / BUILDING_CELL), gz1 = Math.floor((cz + dist) / BUILDING_CELL);
  const EXCLUDE_TYPES = new Set(['industrial', 'shop', 'apartment', 'office']);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = realBuildingIndex.get(gx + ',' + gz);
    if (!arr) continue;
    for (const rec of arr) {
      if (!rec.real) continue;
      if (rec.style && EXCLUDE_TYPES.has(rec.style.type)) continue;
      const dx = rec.x - cx, dz = rec.z - cz;
      if (dx*dx + dz*dz < d2) return true;
    }
  }
  return false;
}

// 【重要・2026-07-16】buildable()の判定順(part8.js)では、landuse=residentialの区画内なら
// 本物の建物の有無に関係なく無条件でtrue(一戸建て補完OK)を返していた。日本のOSMの
// landuse=residentialポリゴンは粗く、実際には大きな商業ビル・オフィスビルの敷地まで
// 覆っていることが多い(特に東京駅周辺のような複合用途エリア)。realBuildingIndexに
// 本物の建物が「登録済み」でも、hasRealBuildingNearby/hasRealHouseNearbyは
// buildable()の4)の分岐(landuseタグ無しの場合)でしか参照されておらず、3)の
// landuse=residential分岐では一切チェックされていなかったため、procedural-infill-race
// 対策(realBuildingIndexの導入)をしても「実は本物の大きい建物がここにある」場所に
// 一戸建てが重なって建ち続けていた(実機報告: 東京駅周辺で本物の建物が0件、手続き生成の
// 小さい住宅のみ100%というdiag結果で発覚)。landuseの判定より前に効く、本物の建物の
// 実フットプリント(中心x,z ± w/2,d/2 に余白pad)に候補地点が入っているかどうかの
// 直接判定を追加し、どの分岐であっても本物の建物に重ねて一戸建てを建てないようにする。
function isInsideKnownRealBuilding(qx, qz, pad) {
  pad = pad || 3;
  const gx = Math.floor(qx / BUILDING_CELL), gz = Math.floor(qz / BUILDING_CELL);
  for (let dgx = -1; dgx <= 1; dgx++) for (let dgz = -1; dgz <= 1; dgz++) {
    const arr = realBuildingIndex.get((gx + dgx) + ',' + (gz + dgz));
    if (!arr) continue;
    for (const rec of arr) {
      if (!rec.real) continue;
      const hw = (rec.w || 8) / 2 + pad, hd = (rec.d || 8) / 2 + pad;
      // 【2026-07-18】以前は軸平行の箱としてしか判定しておらず、道路にフィットさせて
      // 回転済みの実建物(rec.rot≠0)では対角線付近で実際のフットプリントより狭く
      // 判定してしまい、手続き生成の家がその隙間(実際には建物の内側)に重なって
      // 生成されていた。collBoxHitsXZ(part7.js、当たり判定)と同じ逆回転変換で
      // 建物のローカル座標系に直してから判定する(軸平行=rot未設定/0の場合は
      // cos(0)=1,sin(0)=0で従来と同じ結果になるので回転無し建物への影響は無い)。
      const rot = rec.rot || 0;
      const dx = qx - rec.x, dz = qz - rec.z;
      const c = Math.cos(rot), s = Math.sin(rot);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) <= hw && Math.abs(lz) <= hd) return true;
    }
  }
  return false;
}

// ======= PLAYER CHARACTER (少年/少女 選択可・普通の格好) =======
// 以前は魔法使い風(とんがり帽子・マント・杖・光る玉)だったが、素朴な少年/少女の
// 見た目に変更した(マント・杖・光る玉は削除、帽子は少年の短い髪に置き換え)。
const player = new THREE.Group();
scene.add(player);

// Body (シャツ) — 以前は足元まで届く長いローブで脚が隠れていたため、歩く/走るアニメーションを
// 見せられるよう丈を短くし、下に独立した脚パーツを追加した。
const bodyMat = new THREE.MeshLambertMaterial({ color: 0x3020a0 });
const body = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.40, 0.9, 8), bodyMat);
body.position.y = 1.05;
body.castShadow = true;
player.add(body);

// Legs (歩く/走る/ジャンプのアニメーションで振る)
const legMat = new THREE.MeshLambertMaterial({ color: 0x24243a });
const leftLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.64, 8), legMat);
leftLeg.position.set(-0.15, 0.32, 0);
leftLeg.castShadow = true;
player.add(leftLeg);
const rightLeg = leftLeg.clone();
rightLeg.position.set(0.15, 0.32, 0);
player.add(rightLeg);
// Shoes
const shoeMat = new THREE.MeshLambertMaterial({ color: 0x1a1420 });
const leftShoe = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.12, 8), shoeMat);
leftShoe.position.set(-0.15, 0.06, 0.03);
player.add(leftShoe);
const rightShoe = leftShoe.clone();
rightShoe.position.set(0.15, 0.06, 0.03);
player.add(rightShoe);

// Head
const headMat = new THREE.MeshLambertMaterial({ color: 0xf5c8a0 });
const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 12), headMat);
head.position.y = 1.65;
head.castShadow = true;
player.add(head);

// Hair(少年) — 短い髪(帽子ではなく地毛)
const hatMat = new THREE.MeshLambertMaterial({ color: 0x2a1c10 });
const hatBrim = new THREE.Mesh(new THREE.SphereGeometry(0.30, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), hatMat);
hatBrim.position.y = 1.68;
player.add(hatBrim);
const hatTop = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), hatMat); // 前髪の房アクセント
hatTop.position.set(0, 1.83, 0.22);
hatTop.scale.set(1, 0.7, 0.8);
player.add(hatTop);

// Hair(少女) — 帽子の代わりにツインテールの髪型。既定では非表示(setCharacterSexで切替)
const girlHairMat = new THREE.MeshLambertMaterial({ color: 0x3a2210 });
const girlHairTop = new THREE.Mesh(new THREE.SphereGeometry(0.31, 12, 10), girlHairMat);
girlHairTop.position.set(0, 1.68, -0.03);
girlHairTop.scale.set(1.05, 1.05, 0.95);
player.add(girlHairTop);
const girlPonyL = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.04, 0.55, 8), girlHairMat);
girlPonyL.position.set(-0.32, 1.45, 0.02);
girlPonyL.rotation.z = 0.35;
player.add(girlPonyL);
const girlPonyR = girlPonyL.clone();
girlPonyR.position.set(0.32, 1.45, 0.02);
girlPonyR.rotation.z = -0.35;
player.add(girlPonyR);

// Arms
const armMat = new THREE.MeshLambertMaterial({ color: 0x2818a0 });
const leftArm = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.7, 8), armMat);
leftArm.position.set(-0.42, 1.15, 0);
player.add(leftArm);
const rightArm = leftArm.clone();
rightArm.position.set(0.42, 1.15, 0);
player.add(rightArm);

// ======= BIRDモード用の見た目(翼・くちばし) =======
// 【2026-07-27・ユーザー要望】BIRDモード中は腕の代わりに翼を、顔にくちばしを見せる。
// 新規モデルは作らず既存パーツと同じ「単純プリミティブ」路線を踏襲する(ConeGeometryを
// 扁平に潰して翼のシルエットにする)。既定は非表示(visible=false)で、表示切替は
// refreshCharacterVisibility()(part7.js、setViewMode/setBirdModeの両方から呼ばれる)が
// 一元管理する。ここではジオメトリの生成のみ。
const wingMat = new THREE.MeshLambertMaterial({ color: 0x5a4a2a, side: THREE.DoubleSide });
function _makeWing() {
  const wing = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.95, 4), wingMat);
  wing.scale.set(1, 0.1, 0.55); // Y方向に潰して翼のように平たくする
  wing.castShadow = true;
  return wing;
}
const leftWing = _makeWing();
leftWing.position.set(-0.4, 1.2, 0);
leftWing.rotation.z = Math.PI / 2 + 0.25; // 横へ広げる
leftWing.rotation.y = 0.1;
leftWing.visible = false;
player.add(leftWing);
const rightWing = _makeWing();
rightWing.position.set(0.4, 1.2, 0);
rightWing.rotation.z = -(Math.PI / 2 + 0.25);
rightWing.rotation.y = -0.1;
rightWing.visible = false;
player.add(rightWing);

const beakMat = new THREE.MeshLambertMaterial({ color: 0xf0a020 });
const beak = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.22, 6), beakMat);
beak.position.set(0, 1.62, 0.28);
beak.rotation.x = Math.PI / 2;
beak.visible = false;
player.add(beak);

player.position.set(0, 0, 0);

// ======= キャラクター選択(少年/少女) =======
// 帽子/髪型と服の色だけを切り替える(パーツ構成・アニメーションは共通)。
let charSex = 'boy';
function applyCharacterSex(sex) {
  charSex = sex;
  const isGirl = sex === 'girl';
  bodyMat.color.setHex(isGirl ? 0xe0448a : 0x3020a0);
  armMat.color.setHex(isGirl ? 0xc23a78 : 0x2818a0);
  // body.visible は setViewMode が管理する「一人称では非表示」の現在状態を反映している
  // (初期化時はTHREE.Meshの既定値どおりtrue)。これを見て一人称中に帽子/髪を誤って
  // 表示してしまわないようにする。
  hatBrim.visible = hatTop.visible = body.visible && !isGirl;
  girlHairTop.visible = girlPonyL.visible = girlPonyR.visible = body.visible && isGirl;
}
function setCharacterSex(sex) {
  applyCharacterSex(sex);
  try { localStorage.setItem('iseharaCharacterSex', sex); } catch (e) {}
  const boyBtn = document.getElementById('charBoyBtn'), girlBtn = document.getElementById('charGirlBtn');
  if (boyBtn) boyBtn.classList.toggle('active', sex === 'boy');
  if (girlBtn) girlBtn.classList.toggle('active', sex === 'girl');
}
(() => {
  let savedSex = 'boy';
  try { savedSex = localStorage.getItem('iseharaCharacterSex') || 'boy'; } catch (e) {}
  setCharacterSex(savedSex === 'girl' ? 'girl' : 'boy');
})();

// ======= タップ反応(横向き回転後のclickヒットテストずれ対策) =======
// 【2026-07-25】ユーザー報告: 横向き時、hudRail内アイコンと右上UI非表示ボタンの
// タップ反応が悪い(スティック・ジャンプは問題ない)。前者はclickイベントで、
// 後者(joystick/hopBtn)はtouchstart/touchendで動いている。orientationchange直後は
// 「見た目の位置」と「clickのヒットテストが参照するレイアウト」が一瞬ズレる既知の
// ブラウザ挙動(主にiOS Safari)があり、touchstart起点で動く要素は影響を受けないが、
// touchend→click合成に頼る要素はズレの影響をもろに受けていたと考えられる。
// clickを置き換えるのではなく、touchendでも同じ処理を先に済ませ、それにより
// 発火しなくなる後続のclickは何もしない(二重発火防止)、という形でjoystick/hopBtnと
// 同じ土俵(touch起点)に揃える。
function bindTapButton(el, handler) {
  if (!el) return;
  let touched = false;
  el.addEventListener('touchstart', () => { touched = true; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!touched) return;
    touched = false;
    e.preventDefault(); // 後続のclick合成を止める(タップ処理はここで完結させる)
    handler(e);
  }, { passive: false });
  el.addEventListener('touchcancel', () => { touched = false; }, { passive: true });
  el.addEventListener('click', (e) => {
    if (touched) { touched = false; return; } // 万一touchend側が効かなかった場合の保険
    handler(e);
  });
}
