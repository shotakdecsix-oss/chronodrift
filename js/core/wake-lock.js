// 画面スリープ防止: GPS追従(geo)と経路シム(routesim)の間だけ Screen Wake Lock を取る。
// 歩きながら使うモードで画面が消えると、描画も位置の更新も止まるため。
// タブが裏に回るとOSが自動で解除するので、表に戻った時に取り直す。
(function () {
  if (!('wakeLock' in navigator) || !window.ModeRegistry) return;
  const WANT = new Set(['geo', 'routesim']);
  let sentinel = null, inflight = false;
  const wanted = () => {
    const m = ModeRegistry.getActiveMode();
    return !!(m && WANT.has(m.id)) && document.visibilityState === 'visible';
  };
  function sync() {
    if (wanted()) {
      if (sentinel || inflight) return;
      inflight = true;
      navigator.wakeLock.request('screen').then((s) => {
        inflight = false;
        if (!wanted()) { s.release().catch(() => {}); return; }
        sentinel = s;
        s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
      }).catch(() => { inflight = false; });
    } else if (sentinel) {
      const s = sentinel; sentinel = null;
      s.release().catch(() => {});
    }
  }
  const orig = ModeRegistry.switchMode;
  ModeRegistry.switchMode = function () { const r = orig.apply(this, arguments); sync(); return r; };
  document.addEventListener('visibilitychange', sync);
  sync();
})();
