/**
 * js/core/road-batch.js — 【2026-11-10・A-1(道路分)】道路メッシュのまとめ描画。
 *
 * 道路は1区間ごとに形状が違う(地形に沿って約1mごとにサンプルした帯)ためインスタンス化できない。
 * 「セル(500m四方)×マテリアル」ごとに、区間の形状を1つのBufferGeometryへ結合して描く。
 * (以前は区間1本=1メッシュ=1描画コールで、伊勢原でも道路だけで約8,000本あった)
 *
 * 区間側(road record の r.mesh)は、従来どおり scene.add / scene.remove / geometryの差し替え /
 * dispose される軽量な Object3D(RBPart)にする。そのイベントでグループを「要再結合」にするので、
 * part1.js rebuildRoadMesh 等の既存の生成・解放・再構築の経路は変えていない。
 * 再結合はフレーム予算内で、プレイヤーに近いグループから行う(rbUpdate、part9.jsの描画前に呼ぶ)。
 * 切り戻し: URLに ?norbatch=1 を付けると従来どおり1区間=1メッシュ。
 */
const RB_ON = !/[?&]norbatch=1/.test(location.search);
const RB_CELL = 500;
const RB_BUDGET_MS = 3;          // 1フレームで再結合に使う時間
const RB_MIN_INTERVAL_MS = 250;  // 同じグループの再結合の最短間隔(読み込み中に毎フレーム作り直さない)
const RB_ROOT = new THREE.Group();
RB_ROOT.name = 'roadBatch';
let _rbRootAdded = false;
const _rbGroups = new Map(); // key → { key, cx, cz, mat, ro, sig, parts:Set, mesh, last }
const _rbDirty = new Set();
const _rbStat = { rebuilds: 0, verts: 0 };

function _rbSig(geo) {
  if (!geo || !geo.attributes || !geo.attributes.position) return '';
  return (geo.index ? 'i:' : '') + Object.keys(geo.attributes).sort().join(',');
}
class RBPart extends THREE.Object3D {
  constructor(geo, mat, cx, cz) {
    super();
    this._geo = geo;
    this.material = mat;
    this._cx = cx; this._cz = cz;
    this._grp = null;
    this.isRBPart = true;
    this.matrixAutoUpdate = false;
    this.addEventListener('added', () => _rbAttach(this));
    this.addEventListener('removed', () => _rbDetach(this));
  }
  get geometry() { return this._geo; }
  set geometry(g) {
    const resig = this._grp && _rbSig(g) !== this._grp.sig;
    if (resig) _rbDetach(this);
    this._geo = g;
    if (resig) _rbAttach(this); else if (this._grp) _rbDirty.add(this._grp);
  }
}
// 道路区間のメッシュを作る(まとめ描画が無効なら従来どおりのMesh)。cx/czは区間の中点(セル決め用)
function rbMakePart(geo, mat, cx, cz) {
  return RB_ON ? new RBPart(geo, mat, cx, cz) : new THREE.Mesh(geo, mat);
}
function _rbAttach(p) {
  if (!p.parent || !p._geo) return;
  const sig = _rbSig(p._geo);
  if (!sig) return;
  if (!_rbRootAdded) { scene.add(RB_ROOT); _rbRootAdded = true; }
  const gx = Math.floor(p._cx / RB_CELL), gz = Math.floor(p._cz / RB_CELL), ro = p.renderOrder || 0;
  const key = gx + ',' + gz + '|' + p.material.uuid + '|' + ro + '|' + sig;
  let g = _rbGroups.get(key);
  if (!g) {
    g = { key, cx: (gx + 0.5) * RB_CELL, cz: (gz + 0.5) * RB_CELL, mat: p.material, ro, sig, parts: new Set(), mesh: null, last: 0 };
    _rbGroups.set(key, g);
  }
  g.parts.add(p);
  p._grp = g;
  _rbDirty.add(g);
}
function _rbDetach(p) {
  const g = p._grp;
  if (!g) return;
  g.parts.delete(p);
  p._grp = null;
  _rbDirty.add(g);
}
function _rbRebuild(g) {
  g.last = performance.now();
  if (!g.parts.size) {
    if (g.mesh) { RB_ROOT.remove(g.mesh); g.mesh.geometry.dispose(); g.mesh = null; }
    _rbGroups.delete(g.key);
    return;
  }
  let first = null, nv = 0, ni = 0;
  for (const p of g.parts) {
    const geo = p._geo;
    if (!geo) continue;
    if (!first) first = geo;
    nv += geo.attributes.position.count;
    if (geo.index) ni += geo.index.count;
  }
  if (!first) return;
  const names = Object.keys(first.attributes), sizes = names.map(n => first.attributes[n].itemSize);
  const arrs = names.map((n, k) => new Float32Array(nv * sizes[k]));
  const idx = first.index ? (nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni)) : null;
  let vo = 0, io = 0;
  for (const p of g.parts) {
    const geo = p._geo;
    if (!geo) continue;
    const n = geo.attributes.position.count;
    for (let k = 0; k < names.length; k++) {
      const a = geo.attributes[names[k]];
      arrs[k].set(a.array.length === n * sizes[k] ? a.array : a.array.subarray(0, n * sizes[k]), vo * sizes[k]);
    }
    if (idx) { const src = geo.index.array; for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo; io += src.length; }
    vo += n;
  }
  const mg = new THREE.BufferGeometry();
  names.forEach((n, k) => mg.setAttribute(n, new THREE.BufferAttribute(arrs[k], sizes[k])));
  if (idx) mg.setIndex(new THREE.BufferAttribute(idx, 1));
  mg.computeBoundingSphere(); // セル単位で視錐台カリングされる
  if (g.mesh) {
    _rbStat.verts -= g.mesh.geometry.attributes.position.count;
    g.mesh.geometry.dispose();
    g.mesh.geometry = mg;
  } else {
    g.mesh = new THREE.Mesh(mg, g.mat);
    g.mesh.renderOrder = g.ro;
    g.mesh.matrixAutoUpdate = false;
    RB_ROOT.add(g.mesh);
  }
  _rbStat.verts += nv;
  _rbStat.rebuilds++;
}
// 毎フレーム(描画の直前)。要再結合のグループを、プレイヤーに近い順に予算内で作り直す。
function rbUpdate() {
  if (!_rbDirty.size) return;
  const t0 = performance.now();
  const list = [..._rbDirty];
  if (list.length > 1) list.sort((a, b) => priorityDist2(a.cx, a.cz) - priorityDist2(b.cx, b.cz));
  for (const g of list) {
    // 読み込み中に同じグループを毎フレーム作り直さない(まだ描かれていないグループは即時)
    if (g.mesh && t0 - g.last < RB_MIN_INTERVAL_MS) continue;
    _rbDirty.delete(g);
    _rbRebuild(g);
    if (performance.now() - t0 > RB_BUDGET_MS) break;
  }
}
function rbStats() { // 性能HUD用
  if (!RB_ON) return 'road batch off';
  let parts = 0;
  for (const g of _rbGroups.values()) parts += g.parts.size;
  return `道路 ${parts}区間→${_rbGroups.size}描画 ${(_rbStat.verts / 1000).toFixed(0)}k頂点 待ち${_rbDirty.size}`;
}
