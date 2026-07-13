/**
 * ModeRegistry — ゲームプレイモードの登録・切替を管理する軽量レジストリ。
 *
 * 「時代モード」(VISUAL_MODES / MODE_CONF, index.html内) が見た目(現実/明治/江戸/宇宙)を
 * 切り替える軸なのに対し、こちらは「ゲーム性」(3D探索/RPG/アクションなど)を切り替える
 * もう1つ独立した軸として位置づける。
 *
 * 各モードは核となるcore側のコードを一切変更せず、以下のフックを実装して
 * registerMode() するだけで参加できる。
 *
 *   ModeRegistry.registerMode({
 *     id: 'explore',           // 一意なID
 *     label: '3D探索',          // UI表示用ラベル(省略可)
 *     onEnter(ctx) {},          // このモードに入った時
 *     onExit(ctx) {},           // このモードを抜ける時
 *     onUpdate(dt, ctx) {},     // 毎フレーム(animate()から呼ばれる想定)
 *     onInteract(ctx) {},       // 決定/タップ等の操作時
 *     uiPanel: null,            // 今後: モード専用UIパネルの要素/生成関数など
 *   });
 *
 *   ModeRegistry.switchMode('explore', ctx);
 *
 * ctx は呼び出し側が自由に渡せる共有コンテキスト(player, scene, camera など)。
 * このファイル自体は index.html 本体のどのグローバル変数にも依存しない
 * (=既存コードを一切壊さない、純粋な追加ファイル)。
 *
 * 読み込み順: three.js の後、本体スクリプトの前に
 *   <script src="js/core/mode-registry.js"></script>
 * として classic script で読み込む想定(現時点ではESモジュール化していないため)。
 */
(function () {
  'use strict';

  const modes = new Map();
  let activeModeId = null;

  function registerMode(mode) {
    if (!mode || !mode.id) {
      throw new Error('[ModeRegistry] registerMode: "id" is required');
    }
    if (modes.has(mode.id)) {
      console.warn(`[ModeRegistry] mode "${mode.id}" is already registered. Overwriting.`);
    }
    modes.set(mode.id, {
      id: mode.id,
      label: mode.label || mode.id,
      onEnter: typeof mode.onEnter === 'function' ? mode.onEnter : function () {},
      onExit: typeof mode.onExit === 'function' ? mode.onExit : function () {},
      onUpdate: typeof mode.onUpdate === 'function' ? mode.onUpdate : function () {},
      onInteract: typeof mode.onInteract === 'function' ? mode.onInteract : function () {},
      uiPanel: mode.uiPanel || null,
    });
  }

  function switchMode(id, ctx) {
    const next = modes.get(id);
    if (!next) {
      console.warn(`[ModeRegistry] switchMode: unknown mode "${id}"`);
      return false;
    }
    if (id === activeModeId) return true; // 既にアクティブなら何もしない

    const prev = activeModeId ? modes.get(activeModeId) : null;
    if (prev) {
      try { prev.onExit(ctx); } catch (e) { console.error(`[ModeRegistry] onExit(${prev.id}) failed`, e); }
    }
    activeModeId = id;
    try { next.onEnter(ctx); } catch (e) { console.error(`[ModeRegistry] onEnter(${next.id}) failed`, e); }
    return true;
  }

  function update(dt, ctx) {
    if (!activeModeId) return;
    const cur = modes.get(activeModeId);
    if (cur) {
      try { cur.onUpdate(dt, ctx); } catch (e) { console.error(`[ModeRegistry] onUpdate(${cur.id}) failed`, e); }
    }
  }

  function interact(ctx) {
    if (!activeModeId) return;
    const cur = modes.get(activeModeId);
    if (cur) {
      try { cur.onInteract(ctx); } catch (e) { console.error(`[ModeRegistry] onInteract(${cur.id}) failed`, e); }
    }
  }

  function getActiveMode() {
    return activeModeId ? modes.get(activeModeId) : null;
  }

  function listModes() {
    return Array.from(modes.values()).map(m => ({ id: m.id, label: m.label }));
  }

  window.ModeRegistry = { registerMode, switchMode, update, interact, getActiveMode, listModes };
})();
