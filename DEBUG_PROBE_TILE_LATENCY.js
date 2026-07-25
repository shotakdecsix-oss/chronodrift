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
    // (1) キュー投入時刻を退避(成功時にosmTileQueuedAtから削除されてしまうため)
    for (const [sk, t] of osmTileQueuedAt) {
      if (!qAt.has(sk)) qAt.set(sk, { t, tier: tierOf(posOf(sk)) });
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
