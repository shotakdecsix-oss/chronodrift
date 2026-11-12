/**
 * js/core/vt-worker.js — 【2026-11-12・段階4/P-4】ベクタータイルの変換をメインスレッドの外で行うWorker。
 *
 * 【なぜ】1タイルの変換(取得→デコード→Overpass形式への組み立て)は建物1万棟級でメインスレッドを0.1〜0.4秒
 *   止めていた(2026-11-12 実測、docs/CODE_REVIEW_20261109_ZEROBASE.md)。変換本体は vt.js のまま(_vtBatchCore)で、
 *   ここは「依頼を受けて、結果を小分けにして返す」だけ。タイルのLRU・継ぎ目情報もこのWorkerが持つ。
 * 【受け渡し】結果(Overpass形式の要素の配列)は、構造化複製の取り出しがメイン側で約10ms以内になる大きさに
 *   分けて送る('part')。最後に 'done'(海岸線判定用のz14一覧と統計)。失敗は 'err'。
 *   メイン側は js/core/vt.js の _vtWkStart/_vtViaWorker。
 * 【localStorage】Workerからは読めないので、タイルURLのテンプレートはメインが 'init' で渡し、取り直した時は
 *   'tpl' でメインへ保存を頼む。
 */
importScripts('vt.js');
_vtTplSaved = (url, at) => postMessage({ t: 'tpl', url, at });
const _VTW_CHUNK = 16000; // 1通あたりの目安(要素数×6+座標数)。約10ms分の複製
function _vtwWeight(e) {
  let w = 6;
  if (e.geometry) w += e.geometry.length;
  if (e.members) for (const m of e.members) w += 3 + (m.geometry ? m.geometry.length : 0);
  if (e.vtBridgeChain) w += e.vtBridgeChain.geometry.length;
  return w;
}
function _vtwStats() { // メイン側のvtStatsへ上書きする、Worker側で数えている分
  const s = vtStats;
  return { tiles: s.tiles, aux: s.aux, bytes: s.bytes, fetchMs: s.fetchMs, convMs: s.convMs, merged: s.merged, chains: s.chains };
}
onmessage = async (ev) => {
  const m = ev.data;
  if (!m) return;
  if (m.t === 'init') {
    if (m.tpl && m.tpl.url) { _vtTplP = Promise.resolve(m.tpl.url); _vtTplAt = m.tpl.t || 0; }
    return;
  }
  if (m.t !== 'req') return;
  try {
    const r = await _vtBatchCore(m.bboxes, m.kind), els = r.elements;
    let from = 0, w = 0;
    for (let i = 0; i < els.length; i++) {
      w += _vtwWeight(els[i]);
      if (w >= _VTW_CHUNK) { postMessage({ t: 'part', id: m.id, els: els.slice(from, i + 1) }); from = i + 1; w = 0; }
    }
    if (from < els.length) postMessage({ t: 'part', id: m.id, els: els.slice(from) });
    postMessage({ t: 'done', id: m.id, z14: r.z14, stats: _vtwStats() });
  } catch (e) {
    postMessage({ t: 'err', id: m.id, name: e && e.name, message: String((e && e.message) || e), stats: _vtwStats() });
  }
};
