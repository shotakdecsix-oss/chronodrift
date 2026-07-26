// ============================================================================
// タイル取得レイテンシ計測プローブ(ブラウザのコンソールに丸ごと貼り付けて実行)
//
// 何を測るか(デバッグオーバーレイの色遷移と1対1で対応):
//   R = 緑赤灰 → 緑緑赤   : キュー投入 → roadReadyTiles入り(道路クエリの往復時間)
//   B = 緑緑赤 → 緑緑黄   : roadReady  → buildingReadyTiles入り(建物クエリの往復時間)
//
// 使い方:
//   1) このファイルの中身を全部コピーしてコンソールへ貼り付け → Enter
//   2) 1〜3分ふつうに歩く(またはマップジャンプして密集地でしばらく歩く)
//   3) TP.report()     … tier別の集計を表示
//      TP.snap()       … 今この瞬間のキュー/実行中の状態
//      TP.rows()       … 生データ(1タイル1行)
//      TP.stop()       … 計測終了
//   ※ 計測開始時点で既にreadyだったタイルは集計から除外される(初期状態の混入防止)
// ============================================================================
window.TP = (() => {
  const TM = OSM_TILE_M;
  const qAt = new Map();       // stateKey -> {t, tier}   (osmTileQueuedAtから消える前に退避)
  const roadRec = new Map();   // posKey   -> {ms, tier}   ms=null は計測開始前から完了済み
  const bldRec = new Map();
  const roadAt = new Map();    // posKey   -> roadReady観測時刻(Bの起点)
  const t0 = Date.now();
  let timer = null;
  // 【2026-07-27・レビュー指摘の反映】DIRECT(プロキシ障害時のフォールバック)では
  // ディスクキャッシュ・inflight束ね・優先度レーンが全て無効になり、各プレイヤー自身のIPで
  // Overpassの2スロットを取り合う縮退状態になる。その状態で測ったレイテンシは
  // 「通常運転の性能」ではないので、経由を常に記録し、report()で警告を出す。
  const net = { PROXY: 0, DIRECT: 0, ok: 0, ng: 0, statuses: {} };
  // 【2026-07-27・レビュー指摘の反映】R が改善しなかった時、原因が「1クエリが重い」のか
  // 「発行枠(OSM_TILE_CONCURRENCY)が律速」なのかで打つ手が逆になる(前者=道路ジョブ分割、
  // 後者=concurrencyの見直し)。瞬間値のsnapを目視するのでは判断が主観的になるので、
  // tickのたびに稼働枠をサンプリングして占有率の分布として出す。
  //   ・ずっと満杯(2/2に張り付く) -> 枠が律速。concurrencyを上げる話
  //   ・空きが出る時間が相応にある -> 枠は余っている。クエリのコストかbackoffが律速
  const occ = { samples: 0, byActive: {}, queueSum: 0, farSum: 0, coolSamples: 0 };
  (() => {
    const f = window.fetch;
    window.fetch = async function (input) {
      const req = typeof input === 'string' ? input : (input && input.url) || '';
      const r = await f.apply(this, arguments);
      if (/interpreter|api\/overpass/.test(req)) {
        net[/onrender|\/api\/overpass/.test(r.url) ? 'PROXY' : 'DIRECT']++;
        net.statuses[r.status] = (net.statuses[r.status] || 0) + 1;
        if (r.status === 200) net.ok++; else net.ng++;
      }
      return r;
    };
  })();

  const tierOf = (posKey) => {
    const [tx, tz] = posKey.split(',').map(Number);
    const px = Math.floor(player.position.x / TM), pz = Math.floor(player.position.z / TM);
    const d = Math.max(Math.abs(tx - px), Math.abs(tz - pz));
    return d === 0 ? 1 : d === 1 ? 2 : d === 2 ? 3 : 4; // 1=現在地 2=3x3外周 3=5x5外周 4=それ以遠
  };
  const posOf = (stateKey) => stateKey.split('|')[0];

  // 計測開始時点の既存readyは「対象外」として先に埋めておく
  for (const k of roadReadyTiles) roadRec.set(k, { ms: null, tier: 0 });
  for (const k of buildingReadyTiles) bldRec.set(k, { ms: null, tier: 0 });

  const tick = () => {
    const now = Date.now();
    // 稼働枠のサンプリング(250msごと)
    occ.samples++;
    occ.byActive[osmTileActiveCount] = (occ.byActive[osmTileActiveCount] || 0) + 1;
    occ.queueSum += osmTileQueue.length;
    occ.farSum += osmTileActiveFarCount;
    if (osmGlobalCooldownUntil > now) occ.coolSamples++;
    // (1) キュー投入時刻を退避(成功時にosmTileQueuedAtから削除されてしまうため)
    // 【2026-07-27・重大な計測バグの修正】以前は初回tickでosmTileQueuedAtの既存エントリを
    // 全部取り込んでいた。計測開始よりずっと前(ページ読み込み直後など)からキューに滞留して
    // いたタイルの待ち時間がそのままRに混入し、「クエリ往復時間」として177秒などの値が出て
    // いた(実測で誤読の原因になった)。計測開始後にキュー投入されたものだけを対象にする。
    for (const [sk, t] of osmTileQueuedAt) {
      if (qAt.has(sk)) continue;
      if (t < t0) { qAt.set(sk, null); continue; } // 計測開始前からの滞留分は集計対象外として印だけ付ける
      qAt.set(sk, { t, tier: tierOf(posOf(sk)) });
    }
    // (2) 道路確定を検出
    for (const k of roadReadyTiles) {
      if (roadRec.has(k)) continue;
      const q = qAt.get(k + '|road') || qAt.get(k); // 分離ジョブ / 複合クエリ
      roadRec.set(k, q ? { ms: now - q.t, tier: q.tier, kind: qAt.has(k + '|road') ? 'split' : 'combined' }
                       : { ms: null, tier: 0 });
      roadAt.set(k, now);
    }
    // (3) 建物到達を検出
    for (const k of buildingReadyTiles) {
      if (bldRec.has(k)) continue;
      const base = roadAt.get(k);
      const q = qAt.get(k + '|building');
      bldRec.set(k, base ? { ms: now - base, tier: (q || roadRec.get(k) || {}).tier || tierOf(k),
                             kind: q ? 'split' : 'combined' }
                         : { ms: null, tier: 0 });
    }
  };
  timer = setInterval(tick, 250);
  tick();

  const stats = (arr) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return { n: s.length, med: at(0.5), p90: at(0.9), max: s[s.length - 1],
             avg: Math.round(s.reduce((x, y) => x + y, 0) / s.length) };
  };
  const fmt = (o) => o ? `n=${o.n} 中央=${(o.med / 1000).toFixed(1)}s 平均=${(o.avg / 1000).toFixed(1)}s p90=${(o.p90 / 1000).toFixed(1)}s 最大=${(o.max / 1000).toFixed(1)}s` : '(データなし)';

  const collect = (rec, tier) => [...rec.values()].filter(v => v.ms != null && (tier == null || v.tier === tier)).map(v => v.ms);

  return {
    stop() { clearInterval(timer); console.log('[TP] 計測終了'); },
    rows() {
      const out = [];
      for (const [k, r] of roadRec) {
        if (r.ms == null) continue;
        const b = bldRec.get(k);
        out.push({ tile: k, tier: r.tier, 種別: r.kind, 道路R_ms: r.ms, 建物B_ms: (b && b.ms != null) ? b.ms : null });
      }
      out.sort((a, b) => a.tier - b.tier || b.道路R_ms - a.道路R_ms);
      console.table(out);
      return out;
    },
    report() {
      console.log(`%c[TP] 計測時間 ${((Date.now() - t0) / 1000).toFixed(0)}秒`, 'font-weight:bold');
      const tot = net.PROXY + net.DIRECT;
      console.log(`--- 経由: PROXY=${net.PROXY}  DIRECT=${net.DIRECT}  (成功${net.ok}/失敗${net.ng})`, net.statuses);
      // 【2026-07-28・A/B実測を受けて意味を反転】以前ここはDIRECTを「縮退モード」として
      // 赤字警告していたが、A/B計測でRenderのegressがoverpass-api.deに対して6〜7割の確率で
      // 接続レベルから失敗することが判明した(プロキシ経由 成功5/21=24% に対し
      // 直接 成功10/12=83%)。現在はDIRECTが正規の経路で、PROXYの方が例外。
      if (net.PROXY > 0) {
        console.log('%c⚠ PROXY経由のリクエストが混ざっています(' + Math.round(net.PROXY / tot * 100) +
          '%)。現在Overpassは直接アクセスが既定で、__FORCE_PROXY_OVERPASS__ を立てない限り' +
          'PROXYは出ないはずです。設定を確認してください。', 'color:#c00;font-weight:bold');
      }
      // 稼働枠の占有率(枠が律速かクエリが律速かの切り分け)
      if (occ.samples) {
        const pct = (n) => Math.round((occ.byActive[n] || 0) / occ.samples * 100);
        const parts = [];
        for (let i = 0; i <= OSM_TILE_CONCURRENCY; i++) parts.push(`${i}本=${pct(i)}%`);
        const full = pct(OSM_TILE_CONCURRENCY);
        console.log(`--- 稼働枠の占有率(上限${OSM_TILE_CONCURRENCY}): ${parts.join('  ')}` +
          `   平均キュー長=${Math.round(occ.queueSum / occ.samples)}  平均far=${(occ.farSum / occ.samples).toFixed(2)}` +
          `  クールダウン中=${Math.round(occ.coolSamples / occ.samples * 100)}%`);
        // 【2026-07-28・実測で判明したため文言を訂正】以前ここは「満杯ならconcurrencyを
        // 上げる」と表示していたが、これは誤り。上流Overpassは1IPあたり2スロット固定
        // ([overpass status] rate limit=2 available now=0 を実測で複数回観測)なので、
        // 発行枠を増やしても429が増えるだけでthroughputは上がらない。枠が満杯=
        // 「上流の許容量を使い切っている」であり、残る手は【リクエストの本数を減らす】
        // (バッチ化・先読みの削減)しかない。R tier1(1クエリの往復)と見比べること:
        //   R tier1 が速い(10秒前後)のに tier2/3 が数十〜百秒 -> 純粋な待ち行列。本数を減らす
        //   R tier1 自体が遅い(30秒超)                        -> クエリ自体が重い。範囲/条件節を削る
        console.log(`    判定の目安: 満杯${full}% -> ` + (full >= 80
          ? '★ 上流(1IP=2スロット)を使い切っている。concurrencyを上げても429が増えるだけ。' +
            'リクエスト本数を減らす(バッチ化・先読み削減)方向へ'
          : full >= 40 ? '枠とクエリコストが拮抗。R tier1の値と見比べて判断'
                       : '★ 枠が余っている。クエリのコストかbackoffが律速'));
      }
      console.log('--- R: 緑赤灰→緑緑赤(道路クエリ往復) ---');
      for (const t of [1, 2, 3, 4]) console.log(`  tier${t}: ${fmt(stats(collect(roadRec, t)))}`);
      console.log(`  全体  : ${fmt(stats(collect(roadRec, null)))}`);
      console.log('--- B: 緑緑赤→緑緑黄(建物クエリ往復) ---');
      for (const t of [1, 2, 3, 4]) console.log(`  tier${t}: ${fmt(stats(collect(bldRec, t)))}`);
      console.log(`  全体  : ${fmt(stats(collect(bldRec, null)))}`);
      this.snap();
    },
    snap() {
      const now = Date.now();
      const byKind = { road: 0, building: 0, combined: 0 };
      const byTier = { 1: 0, 2: 0, 3: 0, 4: 0 };
      let backoff = 0;
      for (const t of osmTileQueue) {
        byKind[t.kind || 'combined']++;
        byTier[tierOf(t.tx + ',' + t.tz)]++;
        if ((osmTileNextRetryAt.get(tileStateKey(t.tx, t.tz, t.kind)) || 0) > now) backoff++;
      }
      const inflight = [...(_activeFetchStarts || new Map())].map(([k, t]) => `${k.split(':')[1]}(${((now - t) / 1000).toFixed(1)}s)`);
      console.log('--- 現在の状態 ---');
      console.log(`  キュー ${osmTileQueue.length}件  kind別:`, byKind, ' tier別:', byTier, ` backoff中=${backoff}`);
      console.log(`  実行中 ${osmTileActiveCount}/${OSM_TILE_CONCURRENCY}(うちfar=${osmTileActiveFarCount}/${OSM_TILE_CONCURRENCY_FAR_MAX})`);
      console.log('  実行中の内訳(経過秒):', inflight.length ? inflight : '(なし)');
      console.log(`  グローバルクールダウン: ${osmGlobalCooldownUntil > now ? ((osmGlobalCooldownUntil - now) / 1000).toFixed(0) + '秒 残り ★発動中' : 'なし'}  429連続=${_osm429Streak}`);
      console.log(`  諦め(紫)=${gaveUpTiles.size}  road済=${roadReadyTiles.size}  building済=${buildingReadyTiles.size}`);
    },
  };
})();
console.log('[TP] 計測開始。1〜3分歩いたあと TP.report() を実行してください。');
