// 性能HUD: FPS、フレーム時間(平均・p95)、描画コール数、三角形数、ジオメトリ/テクスチャ数、JSヒープ、建物数、建物の生成状況(待ち/隔離/休眠/生成/復帰/1棟)。
// ⚙のデバッグ欄「⏱ 性能表示」でON/OFF(状態はlocalStorageに保存)。OFFの間は計測もしない。
// 改善の効果は必ずこの数値で比べる(体感だけで判断しない)。
(function () {
  const KEY = 'iseharaPerfHud';
  const btn = document.getElementById('perfHudBtn');
  const box = document.createElement('div');
  box.id = 'perfHud';
  box.style.cssText = [
    'position:fixed', 'z-index:60', 'pointer-events:none', 'display:none',
    'top:calc(var(--safe-top, env(safe-area-inset-top, 0px)) + 58px)', 'left:50%', 'transform:translateX(-50%)',
    'padding:6px 9px', 'border-radius:8px', 'background:rgba(10,12,20,.72)', 'color:#d6e6ff',
    'font:11px/1.4 ui-monospace,Menlo,Consolas,monospace', 'white-space:pre',
  ].join(';');
  document.body.appendChild(box);
  const dts = new Float32Array(240);
  // 建物の生成状況。待ち=生成待ちの行列、隔離=地形/道路の確定待ちの退避先、休眠=遠くて(または総数上限で)まだ描かれていない建物。
  // 生成/復帰=表示間隔あたりの件数/秒、1棟=addBuilding1回あたりの平均時間。
  let gPrev = null, gMs = null;
  function genLines(ts) {
    if (typeof GEN_STATS === 'undefined' || typeof pendingBuildings === 'undefined') return '';
    const g = GEN_STATS;
    let genS = '-', revS = '-';
    if (gPrev && ts > gPrev.ts) {
      const dt = (ts - gPrev.ts) / 1000, dn = g.bldN - gPrev.bldN;
      genS = (dn / dt).toFixed(0);
      revS = ((g.rev - gPrev.rev) / dt).toFixed(0);
      if (dn > 0) gMs = (g.bldMs - gPrev.bldMs) / dn;
    }
    gPrev = { ts, bldN: g.bldN, bldMs: g.bldMs, rev: g.rev };
    let wait = 0;
    if (typeof chunkWaitBuildings !== 'undefined') for (const e of chunkWaitBuildings.values()) wait += e.arr.length;
    if (typeof tileWaitBuildings !== 'undefined') for (const e of tileWaitBuildings.values()) wait += e.arr.length;
    const q = pendingBuildings.length - (typeof pendingBuildingIdx !== 'undefined' ? pendingBuildingIdx : 0);
    const dor = (typeof dormantCount !== 'undefined') ? dormantCount : 0;
    return `待ち ${q}  隔離 ${wait}  休眠 ${dor}\n生成 ${genS}/s  復帰 ${revS}/s  1棟 ${gMs === null ? '-' : gMs.toFixed(2)}ms`;
  }
  let on = false, raf = 0, last = 0, lastShow = 0, n = 0, idx = 0;
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (last) { dts[idx] = ts - last; idx = (idx + 1) % dts.length; if (n < dts.length) n++; }
    last = ts;
    if (ts - lastShow < 500) return;
    lastShow = ts;
    const arr = Array.from(dts.subarray(0, n)).sort((a, b) => a - b);
    const avg = arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
    const p95 = arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))] : 0;
    const ri = (typeof renderer !== 'undefined') ? renderer.info : null;
    const mem = performance.memory;
    box.textContent = [
      `FPS ${avg ? (1000 / avg).toFixed(0) : '-'}  frame ${avg.toFixed(1)}ms  p95 ${p95.toFixed(1)}ms`,
      ri ? `draw ${ri.render.calls}  tris ${(ri.render.triangles / 1000).toFixed(0)}k` : '',
      ri ? `geo ${ri.memory.geometries}  tex ${ri.memory.textures}` : '',
      [mem ? `heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)}MB` : '',
       (typeof buildingRecords !== 'undefined') ? `bldg ${buildingRecords.length}` : '',
       (typeof scene !== 'undefined') ? `scene ${scene.children.length}` : ''].filter(Boolean).join('  '),
      genLines(ts),
      (typeof bbStats === 'function') ? bbStats() : '',
      (typeof rbStats === 'function') ? rbStats() : '',
      (typeof signsStats === 'function') ? signsStats() : '',
      (typeof vtStatsText === 'function') ? vtStatsText() : '',
    ].filter(Boolean).join('\n');
  }
  function set(v) {
    on = v;
    box.style.display = v ? 'block' : 'none';
    if (btn) btn.classList.toggle('active', v);
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) {}
    if (v && !raf) { last = 0; n = 0; idx = 0; gPrev = null; raf = requestAnimationFrame(frame); }
    if (!v && raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); set(!on); });
  let saved = false;
  try { saved = localStorage.getItem(KEY) === '1'; } catch (e) {}
  set(saved);
})();
