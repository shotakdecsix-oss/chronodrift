// 性能HUD: FPS、フレーム時間(平均・p95)、描画コール数、三角形数、ジオメトリ/テクスチャ数、JSヒープ、建物数。
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
       (typeof buildingRecords !== 'undefined') ? `bldg ${buildingRecords.length}` : ''].filter(Boolean).join('  '),
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
    if (v && !raf) { last = 0; n = 0; idx = 0; raf = requestAnimationFrame(frame); }
    if (!v && raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); set(!on); });
  let saved = false;
  try { saved = localStorage.getItem(KEY) === '1'; } catch (e) {}
  set(saved);
})();
