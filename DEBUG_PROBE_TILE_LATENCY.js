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
  // 【2026-07-28・案A(先読み削減)を判断するために必須の計器】
  // 「2つしかない稼働枠を、どのtierのジョブがどれだけ占有しているか」を直接測る。
  //   ・既存の 平均far では判別できない。batchSizeが1になる条件(roadReady未達・失敗2回以上・
  //     nearSolo)を踏むとソロ扱い=tilePriority'near'になるため、tier3のジョブが走っていても
  //     farカウンタは0のままになる。実際 実行中:['1,2|road(26.9s)','2,2(4.4s)'] の '2,2' は
  //     combined = tier3以遠(tier1/2は必ずroad/buildingの分離kindで積まれる)。
  //   ・_activeFetchStarts の値は「実行中の経過秒」であって完了時間ではない。過去にこれを
  //     完了中央値と比較して誤った結論を出した。ここでは消滅を検出して“完了時間”を取る。
  // 出力の読み方: tier3/4 が枠時間の相当割合を食っていれば、案A(prefetchR 2→1)は
  // 「tier1/2の待ち行列を直接短くする」施策として根拠を持つ。逆にtier1/2が大半を占めて
  // いるなら先読みを削っても効かないので、案B(条件節削減)へ倒す。
  const TICK_MS = 250;
  const slot = { live: new Map(), msByTier: {}, doneByTier: {}, doneByBatch: {}, occupiedSamples: 0 };
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

  // 【2026-07-28・tier1+ の追加】part8.js は「足元64m圏にかかるタイル」と「ring1のうち
  // プレイヤーに最も近い1枚(格上げ)」を _blockingTiles に入れ、スコア -100000 の最優先で
  // 取得している。ところがこのプローブは距離だけで tier を決めていたため、格上げされた
  // 1枚が tier2 に混ざり、R tier2=108.3s の中で「最優先で走ったはずの1枚」と
  // 「後回しの7枚」が区別できなかった。格上げ枠を tier1+ として分離して測る。
  //   tier1+ ≈ tier1 なら格上げは効いている(tier2の108秒は残り7枚の話)
  //   tier1+ ≈ tier2 なら格上げが機能していない(優先度は実行中のジョブを追い越せないため)
  // 【注意】これは part8.js の _blockingTiles 計算の“写し”。あちらを変えたらここも直すこと
  // (_blockingTiles は fetchOSMTileBatch のローカルconstなので外から参照できない)。
  const _BLOCK_PAD = 64;
  let _blkCache = null, _blkAt = 0;
  const blockingNow = () => {
    const now = Date.now();
    if (_blkCache && now - _blkAt < 200) return _blkCache;
    const px = player.position.x, pz = player.position.z;
    const s = new Set();
    const bx0 = Math.floor((px - _BLOCK_PAD) / TM), bx1 = Math.floor((px + _BLOCK_PAD) / TM);
    const bz0 = Math.floor((pz - _BLOCK_PAD) / TM), bz1 = Math.floor((pz + _BLOCK_PAD) / TM);
    for (let tx = bx0; tx <= bx1; tx++) for (let tz = bz0; tz <= bz1; tz++) s.add(tx + ',' + tz);
    const sx = Math.floor(px / TM), sz = Math.floor(pz / TM);
    let bk = null, bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      const tx = sx + dx, tz = sz + dz, k = tx + ',' + tz;
      if (s.has(k)) continue;
      const x0 = tx * TM, x1 = x0 + TM, z0 = tz * TM, z1 = z0 + TM;
      const nx = Math.max(x0, Math.min(px, x1)), nz = Math.max(z0, Math.min(pz, z1));
      const d2 = (px - nx) * (px - nx) + (pz - nz) * (pz - nz);
      if (d2 < bd) { bd = d2; bk = k; }
    }
    if (bk) s.add(bk);
    _blkAt = now; _blkCache = s;
    return s;
  };
  // tier: 1=現在地 1.5=blocking格上げ(tier1+) 2=3x3外周の残り 3=5x5外周 4=それ以遠
  const TIERS = [1, 1.5, 2, 3, 4];
  const tierName = (t) => (t === 1.5 ? 'tier1+' : 'tier' + t);
  const tierOf = (posKey) => {
    const [tx, tz] = posKey.split(',').map(Number);
    const px = Math.floor(player.position.x / TM), pz = Math.floor(player.position.z / TM);
    const d = Math.max(Math.abs(tx - px), Math.abs(tz - pz));
    if (d === 0) return 1;
    if (d === 1) return blockingNow().has(posKey) ? 1.5 : 2;
    return d === 2 ? 3 : 4;
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
    // 稼働枠をどのtierが占有しているか(_activeFetchStartsの在/不在をサンプリング)
    {
      const af = (typeof _activeFetchStarts !== 'undefined' && _activeFetchStarts) || new Map();
      const seen = new Set();
      for (const [k, st] of af) {
        seen.add(k);
        let v = slot.live.get(k);
        if (!v) {
          // キーは "seq:stateKey|stateKey|..."。stateKeyは "tx,tz" か "tx,tz|kind"。
          const tiles = (k.split(':')[1] || '').match(/-?\d+,-?\d+/g) || [];
          const tiers = tiles.map(tierOf);
          v = { st, tier: tiers.length ? Math.min(...tiers) : 0, size: tiles.length || 1 };
          slot.live.set(k, v);
        }
        slot.msByTier[v.tier] = (slot.msByTier[v.tier] || 0) + TICK_MS;
      }
      if (seen.size) slot.occupiedSamples++;
      for (const [k, v] of slot.live) {
        if (seen.has(k)) continue;
        slot.live.delete(k);
        if (v.st < t0) continue; // 計測開始前から走っていた分は完了時間として信用しない
        (slot.doneByTier[v.tier] = slot.doneByTier[v.tier] || []).push(now - v.st);
        (slot.doneByBatch[v.size] = slot.doneByBatch[v.size] || []).push(now - v.st);
      }
    }
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
      // 【2026-07-28・警告の反転を撤回して元に戻す】いったんは「A/Bの結果DIRECTが正規経路」
      // として警告を反転させたが、その根拠だった「Renderのegressが接続レベルで死んでいる」は
      // CONN_FAIL_CODESの誤分類(ECONNRESET/ETIMEDOUT等を到達不能に算入していた)による
      // 誤判定だった可能性が高い。誤判定に基づいて縮退経路を「正常」と報告するプローブは、
      // 次のセッションで正しい経路の方を異常として告発してしまう。元の意味に戻す。
      // DIRECTが本当に妥当かどうかは、CONN_FAIL_CODES修正後にPROXY経路で取り直してから判断する。
      if (net.DIRECT > 0) {
        console.log('%c⚠ この計測は縮退モード(DIRECT)を含みます。DIRECTではサーバーのディスク' +
          'キャッシュ・inflight束ね・優先度レーンが全て無効で、ユーザー自身のIPでOverpassの' +
          '2スロットを奪い合うため、レイテンシは通常運転の値ではありません。' +
          (net.PROXY === 0 ? ' 全リクエストがDIRECTです。この結果で性能判断をしないでください。'
                           : ' DIRECT混入率 ' + Math.round(net.DIRECT / tot * 100) + '%。'),
          'color:#c00;font-weight:bold');
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
      // 稼働枠を誰が食っているか(案A=先読み削減 を決めるための本命データ)
      {
        const totMs = Object.values(slot.msByTier).reduce((a, b) => a + b, 0);
        if (totMs) {
          const share = TIERS.map(t => `${tierName(t)}=${Math.round((slot.msByTier[t] || 0) / totMs * 100)}%`).join('  ');
          console.log(`--- 稼働枠の占有をtier別に分解(枠時間の合計 ${(totMs / 1000).toFixed(0)}秒): ${share}`);
          const near = ((slot.msByTier[1] || 0) + (slot.msByTier[1.5] || 0) + (slot.msByTier[2] || 0)) / totMs;
          console.log('    判定の目安: ' + (near < 0.5
            ? `★ tier3以遠が枠時間の${Math.round((1 - near) * 100)}%を占有。先読み(PERF.prefetchR)の削減=案Aに根拠あり`
            : `tier1/2が枠時間の${Math.round(near * 100)}%。先読みを削っても効きが薄い。案B(条件節削減)を優先`));
        }
        const line = (label, m, nm) => {
          const ks = Object.keys(m).sort((a, b) => a - b);
          if (!ks.length) return;
          console.log(`    ${label}: ` + ks.map(k => `${nm ? nm(Number(k)) : k}:${fmt(stats(m[k]))}`).join('\n              '));
        };
        // ここは「発行から完了までの実測」= 純粋なクエリ往復。キュー待ちを含まない。
        // R tier2 が数十秒でも、この値が10秒前後なら差分はすべてキュー待ちだと確定できる。
        line('完了時間(キュー待ちを除く純粋な往復)tier別', slot.doneByTier, tierName);
        line('同 バッチ枚数別(枚数×条件節の仮説の検証用)', slot.doneByBatch);
      }
      const tierLines = (rec) => {
        for (const t of TIERS) console.log(`  ${tierName(t).padEnd(6)}: ${fmt(stats(collect(rec, t)))}`);
        console.log(`  全体  : ${fmt(stats(collect(rec, null)))}`);
        // tier1+(blocking格上げ枠)が機能しているかの判定
        const a = stats(collect(rec, 1.5)), b = stats(collect(rec, 2)), c = stats(collect(rec, 1));
        if (a && b && c) {
          const near1 = Math.abs(a.med - c.med), near2 = Math.abs(a.med - b.med);
          console.log('    tier1+の判定: ' + (near1 <= near2
            ? '★ 格上げは効いている(tier1側に寄っている)。tier2の遅さは残り7枚の話'
            : '★ 格上げが効いていない(tier2側に寄っている)。優先度は実行中ジョブを追い越せない' +
              'ため、枠を増やすのではなく1本の実行時間を短くする方向へ'));
        }
      };
      console.log('--- R: 緑赤灰→緑緑赤(道路クエリ往復) ---');
      tierLines(roadRec);
      console.log('--- B: 緑緑赤→緑緑黄(建物クエリ往復) ---');
      tierLines(bldRec);
      this.snap();
    },
    snap() {
      const now = Date.now();
      const byKind = { road: 0, building: 0, combined: 0 };
      const byTier = { 1: 0, 1.5: 0, 2: 0, 3: 0, 4: 0 };
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
