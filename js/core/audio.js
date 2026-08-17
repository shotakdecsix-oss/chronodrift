/**
 * js/core/audio.js — 環境音(Web Audioによる手続き合成)。
 * 【2026-08-16実装】IMPL_PROMPT_20260816_AMBIENT_AUDIO.md Phase1(骨格+波+風+足音)。
 * 合成パラメータは相談チャットでユーザー承認済みのプロトタイプ PROTO_20260816_SFX.html から
 * そのまま移植している(音色を作り直していない)。
 *
 * mode-registry.js と同じ方針の「純粋な追加ファイル」。
 * - classic script(ESモジュールではない)。window.GameAudio だけを公開する。
 * - THREE にも本体(player/scene等)のグローバル変数にも load 時点で依存しない。
 *   環境値は呼び出し側(part9.js)から引数で渡してもらう。
 * - 既定は音OFF。ユーザーが設定(⚙)で明示的にONにするまで AudioContext を作らない。
 * - AudioContext の生成・resume() は必ずユーザー操作イベントの中で行う(iOS/Safari制約)。
 * - 音声ファイルは一切使わない。ノイズ/インパルス応答も全て起動時に手続き生成する。
 *
 * 【env引数についての注記】
 * 公開APIの env は元仕様では {seaDist, waterNear, forest, urban, surface} の5項目のみだが、
 * 足音(4-3)は「毎フレームの水平移動距離」が必要で、これは landuseTypeAt 等と違って
 * ポリゴン走査を伴わない(変数の引き算のみ)ため 250ms 間引きの対象にする理由がない。
 * このため part9.js 側の _audioEnv() は move/airborne/altLocked をこのenvオブジェクトに
 * 同居させ、これらだけは毎フレーム最新値に更新している(詳細はpart9.js側のコメント参照)。
 * update(dt, env) のシグネチャ自体は変えていない。
 *
 * 【i18nについての注記】設定UIの文言はjs/legacy/part1.jsの既存I18N/t()テーブルに統合済み
 * (audioSectionTitle/audioToggleOn/audioToggleOff/audioDesc)。index.html側の対象要素には
 * data-i18n属性を付けてあり、既存のapplyI18n()がそのまま拾う。
 */
(function () {
  'use strict';

  // ============================================================
  // 定数
  // ============================================================
  const MAX_VOICES = 24;           // 同時に生きているOscillatorNode/BufferSourceの上限(原則D)
  const STRIDE_WALK = 0.78;        // m/歩(通常歩行)
  const STRIDE_RUN = 1.35;         // m/歩(走り。水平速度8km/h超)
  const RUN_KMH = 8;               // これを超えたら走りストライドに切替
  const VEHICLE_KMH = 12;          // これを超えたら乗り物移動とみなし足音を止める
  const TELEPORT_GUARD_M = 5;      // 1フレームでこれを超える移動はテレポート/モード切替とみなし無視
  const ENV_SMOOTH_TAU = 0.35;     // forest/urban/海の近さを目標値へ寄せる時定数(秒)
  const SEA_AUDIBLE_DIST = 400;    // seaDist(海岸までの距離,m)がこの範囲内で波の音が聞こえ始める
  const LOOP_MAX = { sea: 0.85, wind: 0.7 }; // 継続音の音量上限(プロトタイプのLOOPMAXを踏襲)
  const LS_ON = 'iseharaAudioOn';
  const LS_VOL = 'iseharaAudioVol';

  // ============================================================
  // 状態
  // ============================================================
  let ctx = null, N = null;
  let enabled = false;             // ユーザーが設定(⚙)でONにしたか
  let volume = 0.7;                // 0..1
  let voices = 0;                  // 現在の同時発音数(単発音のみカウント。継続音の下地は含まない)
  let suspendedByVisibility = false;

  let _lastEnv = null;
  let _footAcc = 0;
  let _nextWave = 0;
  let _windTarget = 0.5, _windTargetT = 0;

  try { volume = (parseFloat(localStorage.getItem(LS_VOL)) || 70) / 100; } catch (e) {}

  // ============================================================
  // 共通ユーティリティ(PROTO_20260816_SFX.html より)
  // ============================================================
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function noiseBuf(kind, sec) {
    const ac = ctx;
    const len = ac.sampleRate * sec, b = ac.createBuffer(1, len, ac.sampleRate), d = b.getChannelData(0);
    if (kind === 'brown') {
      let last = 0;
      for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    } else if (kind === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return b;
  }
  function srcNode(buf, loop) { const s = ctx.createBufferSource(); s.buffer = buf; if (loop) s.loop = true; return s; }
  function bq(type, freq, q) { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (q != null) f.Q.value = q; return f; }
  function gainNode(v) { const g = ctx.createGain(); g.gain.value = v == null ? 1 : v; return g; }
  function pannerNode(v) { const p = ctx.createStereoPanner(); p.pan.value = v || 0; return p; }
  function hitEnv(g, t, peak, dec, atk) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + (atk || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
  }

  // ============================================================
  // 発音数予算(原則D): 単発音を1つ作るたびに reserveVoice()。
  // 上限に達している間は新しい単発音を作らない(黙って捨てる。キューに積まない)。
  // ============================================================
  function reserveVoice(durMs) {
    if (voices >= MAX_VOICES) return false;
    voices++;
    setTimeout(() => { voices = Math.max(0, voices - 1); }, Math.max(0, durMs));
    return true;
  }

  // ============================================================
  // 音声グラフの土台(build())
  // ============================================================
  function buildGraph() {
    const ac = ctx;
    N = {};
    N.master = ac.createGain(); N.master.gain.value = 0;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
    N.master.connect(comp); comp.connect(ac.destination);

    // ごく薄い残響(屋外の広がり)。インパルス応答は手続き生成(音声ファイルは使わない)
    N.revIn = ac.createGain(); N.revIn.gain.value = 1;
    const conv = ac.createConvolver();
    (function () {
      const sec = 1.6, len = ac.sampleRate * sec, b = ac.createBuffer(2, len, ac.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
      }
      conv.buffer = b;
    })();
    const revOut = ac.createGain(); revOut.gain.value = 0.22;
    N.revIn.connect(conv); conv.connect(revOut); revOut.connect(N.master);

    // ノイズバッファは起動時に一度だけ生成して使い回す(毎回createBufferするとGC圧になる)
    N.white = noiseBuf('white', 3);
    N.pink = noiseBuf('pink', 3);
    N.brown = noiseBuf('brown', 3);

    // forest/urban/海の近さを時定数0.35秒で滑らかに追従させるための値保持専用ノード
    // (setTargetAtTimeが使えるのはAudioParamのみなので、GainNodeを値ホルダとして流用する)。
    // Phase1では envSea だけを実際の音に使う。envForest/envUrbanはPhase2の街・森アンビエンス
    // 追加時にここから読む前提で先に用意しておく(未接続=無音のまま)。
    N.envForest = gainNode(0);
    N.envUrban = gainNode(0);
    N.envSea = gainNode(0);

    buildSea();
    buildWind();

    N.master.gain.setTargetAtTime(volume, ac.currentTime, 0.3);
  }

  // --- 海: 遠くの潮の下地(継続)。個々の波はwaveOne()の単発イベントで重ねる ---
  function buildSea() {
    const seaBed = gainNode(0); seaBed.connect(N.master);
    const s = srcNode(N.white, true);
    const lp = bq('lowpass', 300, 0.9);
    const g = gainNode(0.3);
    s.connect(lp); lp.connect(g); g.connect(seaBed); s.start();
    N.loopOut = { sea: seaBed };
  }

  // --- 風: 低い唸り(brown+lowpass) + 共鳴の鋭いバンドパス(これが「ヒュー」を作る) + 強風時の笛 ---
  function buildWind() {
    const windOut = gainNode(0); windOut.connect(N.master); windOut.connect(N.revIn);
    const wLow = srcNode(N.brown, true), wLowF = bq('lowpass', 260, 0.8), wLowG = gainNode(0.55);
    wLow.connect(wLowF); wLowF.connect(wLowG); wLowG.connect(windOut); wLow.start();
    const wHowl = srcNode(N.white, true), wHowlF = bq('bandpass', 600, 6.5), wHowlG = gainNode(0.5);
    wHowl.connect(wHowlF); wHowlF.connect(wHowlG); wHowlG.connect(windOut); wHowl.start();
    const wWhis = srcNode(N.white, true), wWhisF = bq('bandpass', 1500, 16), wWhisG = gainNode(0);
    wWhis.connect(wWhisF); wWhisF.connect(wWhisG); wWhisG.connect(windOut); wWhis.start();
    N.wind = { out: windOut, howlF: wHowlF, howlG: wHowlG, whisG: wWhisG, lowG: wLowG };
  }

  // 風の「強さ」= 時間方向のゆらぎ(突風。GPS上の実風速データが無いための内部乱数)×
  // 場所方向の係数(海岸に近いほど強く、森・市街地は遮蔽で弱まる)。
  // 【2026-08-17修正】当初は場所に依存しない実装だったが、「どこにいても同じ風では
  // 実在の場所を歩いていることが音に出ない=機能の目的の半分が失われる」との指摘を受け、
  // 既存env(5項目)のseaDist/forest/urbanだけで場所係数を組む形に変更した。
  function updateWind(dt, t, env) {
    _windTargetT -= dt;
    if (_windTargetT <= 0) {
      _windTarget = 0.28 + Math.random() * 0.5;   // 0.28〜0.78(突風のゆらぎ)
      _windTargetT = 6 + Math.random() * 10;       // 6〜16秒ごとに変化
    }
    const seaDist = (env && env.seaDist != null) ? env.seaDist : Infinity;
    const forest = (env && env.forest) || 0;
    const urban = (env && env.urban) || 0;
    const coast = seaDist < 1500 ? 1 - seaDist / 1500 : 0;            // 岸に近いほど強い(1500mで消える)
    const shelter = Math.max(0.25, 1 - 0.55 * forest - 0.30 * urban); // 森と市街地は遮蔽で弱まる
    const place = Math.min(1, 0.35 + 0.65 * coast) * shelter;
    const w = _windTarget * place;
    N.wind.out.gain.setTargetAtTime(w * LOOP_MAX.wind, t, 0.6);
    N.wind.howlF.frequency.setTargetAtTime(420 + w * 900, t, 0.6);
    N.wind.howlF.Q.setTargetAtTime(4 + w * 9, t, 0.6);
    N.wind.whisG.gain.setTargetAtTime(Math.max(0, (w - 0.55)) * 0.55, t, 0.6);
  }

  // --- 波: 寄せる(ローパスが開いていく)→砕ける(広帯域の破裂)→引く(泡がはじける高域)の3段階。
  // この3段構造が「波に聞こえる」ことの本体(ノイズをLFOで揺らすだけの簡略化は却下済み)。
  function waveOne(amt, when) {
    const t = when || ctx.currentTime;
    const dur = 3.4 + Math.random() * 2.4;
    const p = pannerNode((Math.random() - 0.5) * 1.2);
    p.connect(N.master);
    const rs = gainNode(0.3); p.connect(rs); rs.connect(N.revIn);

    // ① 寄せ
    if (reserveVoice((dur + 0.2) * 1000)) {
      const s1 = srcNode(N.white, true), f1 = bq('lowpass', 180, 1.0), g1 = gainNode(0);
      s1.connect(f1); f1.connect(g1); g1.connect(p);
      f1.frequency.setValueAtTime(180, t);
      f1.frequency.linearRampToValueAtTime(1400, t + dur * 0.42);
      f1.frequency.linearRampToValueAtTime(600, t + dur);
      g1.gain.setValueAtTime(0.0001, t);
      g1.gain.exponentialRampToValueAtTime(0.42 * amt, t + dur * 0.40);
      g1.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.9);
      s1.start(t, Math.random() * 2); s1.stop(t + dur + 0.1);
    }

    // ② 砕ける
    const tc = t + dur * 0.42;
    if (reserveVoice(1300)) {
      const s2 = srcNode(N.white, true), f2 = bq('bandpass', 1100, 0.45), g2 = gainNode(0);
      s2.connect(f2); f2.connect(g2); g2.connect(p);
      f2.frequency.setValueAtTime(900, tc);
      f2.frequency.exponentialRampToValueAtTime(2600, tc + 0.35);
      g2.gain.setValueAtTime(0.0001, tc);
      g2.gain.exponentialRampToValueAtTime(0.34 * amt, tc + 0.14);
      g2.gain.exponentialRampToValueAtTime(0.0001, tc + 1.1);
      s2.start(tc, Math.random() * 2); s2.stop(tc + 1.2);
    }

    // ③ 引き波
    const tr = t + dur * 0.55;
    if (reserveVoice((dur * 0.5 + 0.2) * 1000)) {
      const s3 = srcNode(N.white, true), f3 = bq('highpass', 1600), g3 = gainNode(0);
      s3.connect(f3); f3.connect(g3); g3.connect(p);
      g3.gain.setValueAtTime(0.0001, tr);
      g3.gain.exponentialRampToValueAtTime(0.20 * amt, tr + 0.3);
      g3.gain.exponentialRampToValueAtTime(0.0001, tr + dur * 0.5);
      s3.start(tr, Math.random() * 2); s3.stop(tr + dur * 0.5 + 0.1);
    }
  }

  // --- 足音(プロトタイプのSURFテーブルをそのまま移植) ---
  // 公開env仕様の surface は asphalt/grass/gravel/water の4種。gravelは現状part9.jsの
  // _audioEnvからは出てこないが(4-5表: 舗装/水/既定=草のみ)、API仕様どおりテーブルには残す。
  const SURF = {
    asphalt: { type: 'bandpass', f: 1500, q: 1.1, dec: 0.075, amp: 0.55, grains: 1 },
    grass: { type: 'lowpass', f: 820, q: 0.9, dec: 0.130, amp: 0.42, grains: 1 },
    gravel: { type: 'highpass', f: 1300, q: 0.8, dec: 0.110, amp: 0.50, grains: 4 },
    water: { type: 'bandpass', f: 2200, q: 1.0, dec: 0.160, amp: 0.45, grains: 3 },
  };
  function footstep(surface) {
    const cfg = SURF[surface] || SURF.grass;
    for (let i = 0; i < cfg.grains; i++) {
      if (!reserveVoice((cfg.dec + 0.1) * 1000)) continue; // 予算切れなら黙って捨てる
      const t = ctx.currentTime + (i ? Math.random() * 0.04 : 0);
      const s = srcNode(N.white, false);
      s.playbackRate.value = 0.85 + Math.random() * 0.3;
      const f = bq(cfg.type, cfg.f * (0.85 + Math.random() * 0.3), cfg.q);
      const g = gainNode(0);
      s.connect(f); f.connect(g); g.connect(N.master);
      hitEnv(g, t, cfg.amp * (0.75 + Math.random() * 0.4) / (i ? 2.6 : 1), cfg.dec, 0.005);
      s.start(t, Math.random() * 2); s.stop(t + cfg.dec + 0.05);
    }
  }

  // 距離ベースで足音を鳴らす(4-3の設計判断: 速度変数を読むのではなく、プレイヤーの水平移動距離を
  // 積算しSTRIDEメートル進むたびに1歩鳴らす。歩行・GPS追従・経路シムの全モードで自動的に正しく
  // 鳴らすため)。ゲート: airborne / altLocked / 水平速度>12km/hのいずれかで鳴らさない。
  function updateFootsteps(dt, env) {
    if (env.airborne || env.altLocked) { _footAcc = 0; return; }
    if (!dt || dt <= 0 || !(env.move >= 0)) return;
    const kmh = (env.move / dt) * 3.6;
    if (kmh > VEHICLE_KMH) { _footAcc = 0; return; }
    const stride = kmh > RUN_KMH ? STRIDE_RUN : STRIDE_WALK;
    _footAcc += env.move;
    let guard = 8; // 1フレームで大量に鳴らさないための保険(通常は1〜2回で抜ける)
    while (_footAcc >= stride && guard-- > 0) {
      _footAcc -= stride;
      footstep(env.surface);
    }
  }

  // ============================================================
  // 公開API
  // ============================================================
  function enable() {
    enabled = true;
    try { localStorage.setItem(LS_ON, '1'); } catch (e) {}
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      buildGraph();
    }
    if (ctx.state === 'suspended') ctx.resume();
    suspendedByVisibility = false;
  }

  function disable() {
    enabled = false;
    try { localStorage.setItem(LS_ON, '0'); } catch (e) {}
    if (ctx && ctx.state === 'running') ctx.suspend();
  }

  function setVolume(v) {
    volume = clamp01(v);
    try { localStorage.setItem(LS_VOL, String(Math.round(volume * 100))); } catch (e) {}
    if (ctx && N) N.master.gain.setTargetAtTime(volume, ctx.currentTime, 0.15);
  }

  function update(dt, env) {
    if (!enabled || !ctx || ctx.state !== 'running' || !N) return;
    if (env) _lastEnv = env; else env = _lastEnv;
    if (!env) return; // 最初のサンプリングがまだ来ていない

    const t = ctx.currentTime;

    // --- forest/urban/海の近さを時定数0.35秒で目標値へ寄せる(境界を跨いだ瞬断を防ぐ) ---
    const seaTarget = env.seaDist === Infinity ? 0 : clamp01(1 - env.seaDist / SEA_AUDIBLE_DIST);
    N.envSea.gain.setTargetAtTime(seaTarget, t, ENV_SMOOTH_TAU);
    N.envForest.gain.setTargetAtTime(env.forest || 0, t, ENV_SMOOTH_TAU);
    N.envUrban.gain.setTargetAtTime(env.urban || 0, t, ENV_SMOOTH_TAU);
    const seaAmt = N.envSea.gain.value; // 直前フレームまでの平滑値の近似読み出し

    // --- 海(継続ベッド+波イベントのスケジューリング) ---
    N.loopOut.sea.gain.setTargetAtTime(seaAmt * LOOP_MAX.sea, t, 0.35);
    if (seaAmt > 0.02) {
      if (t > _nextWave) {
        waveOne(seaAmt, t + 0.05);
        _nextWave = t + 2.6 + Math.random() * 2.2 - seaAmt * 0.9;
      }
    } else {
      _nextWave = 0;
    }

    // --- 風 ---
    updateWind(dt, t, env);

    // --- 足音 ---
    updateFootsteps(dt, env);
  }

  // 単発音。Phase1では合成関数を未実装(Phase2以降でcarPass/trainPass/horn/thunder/
  // crossingBellを追加する)。呼び出し自体はエラーにせず、未対応の名前は黙って無視する。
  function oneShot(name) {
    if (!enabled || !ctx || ctx.state !== 'running' || !N) return;
    console.warn('[GameAudio] oneShot("' + name + '") is not implemented yet (Phase 2+).');
  }

  function debug() {
    return {
      enabled: enabled,
      voices: voices,
      volume: volume,
      ctxState: ctx ? ctx.state : 'none',
      levels: { sea: N ? N.envSea.gain.value : 0, wind: _windTarget },
    };
  }

  // タブ離脱で止める(バッテリー対策。プロトタイプで「裏で鳴り続ける」不具合が実際に
  // 起きたことの再発防止でもある)。disable()による意図的なsuspendとは
  // suspendedByVisibilityフラグで区別し、タブに戻った時にユーザーが手動でOFFにしていた
  // 場合は再開しない。
  function _suspend() {
    if (ctx && ctx.state === 'running') { ctx.suspend(); suspendedByVisibility = true; }
  }
  function _resumeIfEnabled() {
    if (enabled && ctx && suspendedByVisibility) { ctx.resume(); suspendedByVisibility = false; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) _suspend(); else _resumeIfEnabled();
  });

  window.GameAudio = {
    enable: enable,
    disable: disable,
    setVolume: setVolume,
    update: update,
    oneShot: oneShot,
    debug: debug,
    _suspend: _suspend,
    _resumeIfEnabled: _resumeIfEnabled,
  };

  // ============================================================
  // 設定UI配線 + 初回タップでの自動有効化
  // ============================================================
  // 【2026-08-17修正】当初はaudio.js内に自前の日英辞書を持たせていたが、「対象ファイル」の
  // 列挙漏れが原因で、既存のt()/I18Nテーブル(part1.js)に統合すべきというフィードバックを受け、
  // 既存の仕組みに乗せる形に変更した。文言そのものはpart1.jsのI18N.ja/enに追加済み
  // (audioSectionTitle/audioToggleOn/audioToggleOff/audioDesc)。index.html側の該当要素には
  // data-i18n属性を付けてあるので、静的な文言(タイトル・説明文)は既存のapplyI18n()が
  // 自動で反映する。ON/OFFで文言が変わるトグルボタンだけはここでdata-i18n属性ごと
  // 書き換えることで、次回のapplyI18n()呼び出し(=言語切替時)でも正しい文言に追従する。
  function wireAudioUI() {
    const toggleBtn = document.getElementById('audioToggleBtn');
    const volSlider = document.getElementById('audioVolSlider');
    if (!toggleBtn && !volSlider) return; // 設定UIが無い(=index.htmlが未更新)場合は何もしない

    function refreshToggleLabel() {
      if (!toggleBtn) return;
      const key = enabled ? 'audioToggleOn' : 'audioToggleOff';
      toggleBtn.setAttribute('data-i18n', key);
      toggleBtn.textContent = (typeof t === 'function') ? t(key) : (enabled ? '🔊 ON' : '🔇 OFF');
      toggleBtn.classList.toggle('active', enabled);
    }

    if (toggleBtn) {
      const handler = function () {
        if (enabled) disable(); else enable();
        refreshToggleLabel();
      };
      // 既存のタップ反応不具合(横向き時にclickだけでは発火しないことがある)対策として、
      // 既存のbindTapButton(part1.js)を必ず使う。part1.jsはaudio.jsより後に読み込まれる
      // (index.html上でaudio.jsはpart1.jsより前)ため、DOMContentLoaded後(=wireAudioUI呼び出し
      // 時点)であればbindTapButtonは既に定義済みのはず。念のためtypeof確認する。
      if (typeof bindTapButton === 'function') bindTapButton(toggleBtn, handler);
      else toggleBtn.addEventListener('click', handler); // フォールバック(通常到達しない)
    }

    if (volSlider) {
      volSlider.value = String(Math.round(volume * 100));
      volSlider.addEventListener('input', function () {
        setVolume(parseFloat(volSlider.value) / 100);
      });
    }

    refreshToggleLabel();
  }
  // index.html上でaudio.jsは<body>の全マークアップより後・全part.jsより前に読み込まれるため、
  // 設定UIの要素自体はDOM上に既に存在するが、bindTapButton(part1.js)はまだ未定義の可能性がある。
  // DOMContentLoadedまで待てば全part.jsの実行(同期scriptなので必ず先に終わっている)後になり、
  // 安全にbindTapButtonを使える。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireAudioUI);
  } else {
    wireAudioUI();
  }

  // 保存値がONなら、最初のユーザー操作(タップ/クリック)で自動的にenable()する。
  // AudioContextの生成・resumeは必ずユーザー操作イベントの中で行う(原則C)。
  (function initAutoEnable() {
    let savedOn = false;
    try { savedOn = localStorage.getItem(LS_ON) === '1'; } catch (e) {}
    if (!savedOn) return;
    const onFirstInteract = function () {
      document.removeEventListener('touchend', onFirstInteract);
      document.removeEventListener('click', onFirstInteract);
      enable();
    };
    document.addEventListener('touchend', onFirstInteract, { passive: true });
    document.addEventListener('click', onFirstInteract);
  })();
})();
