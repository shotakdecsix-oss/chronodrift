// 建物の部品を「セル(500m四方)×形状×マテリアル」ごとのInstancedMeshにまとめて描く(現実モードのみ)。
// 以前は部品1個=Mesh1個=描画コール1回で、建物数に比例して描画コールが数千件に増えていた。
// 部品はscene.add/removeされる軽量なObject3D(BBPart)のままにし、追加・削除のイベントで
// インスタンスを登録・解除する。解放・休眠・再生成など「partsを回してscene.remove」する既存処理は
// そのまま動く。部品の位置を後から変える処理(建物の回転適用、地形への再スナップ)は bbSync(parts) を呼ぶ。
// 色はインスタンスごとの属性(aCol)で渡すので、壁色・屋根色が違っても同じ描画コールにまとまる。
// URLに ?nobatch=1 を付けると従来の1部品1メッシュに戻る(スマホでの性能比較用)
const BB_ON = (MODE === 'real') && !/[?&]nobatch=1/.test(location.search);
const BB_CELL = 500;
const BB_ROOT = new THREE.Group(); // まとめ描画のメッシュの親。generateChunkのscene.children追跡に混ざらないよう別ノードにする
BB_ROOT.name = 'bldgBatches';
scene.add(BB_ROOT);
// 部品(建物のBBPart。道路・看板・外形建物のRBPartはRB_HOLDER、road-batch.js)はsceneに繋がず、holderの子にする。
// 部品は自分では描画されず、位置・形状は追加時にバッチへ書き込み済み。sceneの子にすると建物・道路の数に比例して
// (数万)増え、毎フレームのupdateMatrixWorldと描画準備の走査がその数だけ空回りする。holderは孤立ノード(sceneの子ではない)
// なのでどちらにも入らない。'added'/'removed'は従来どおり発火し(addの時点でp.parentはholder)、登録・解除も同じ。
// 解放側は scene.remove ではなく p.parent.remove を使う。
// Object3D.removeはindexOf+spliceでO(n)なので、holderだけ番号(_hi)で入れ替えて外す(O(1)。js/lib/pure.js)。
// 外すと並びが変わるため、generateChunk(part8.js)の「増えた分を後ろから数える」処理は、その間に解放が起きない前提(BB_HOLDERだけが対象)。
const _bbEvAdded = { type: 'added' }, _bbEvRemoved = { type: 'removed' };
function makePartsHolder(name) {
  const h = new THREE.Group();
  h.name = name;
  h.visible = false;
  h.updateMatrixWorld = function () {};
  h.add = function (p) {
    if (p.parent) p.parent.remove(p);
    p.parent = this;
    idxPush(this.children, p);
    p.dispatchEvent(_bbEvAdded);
    return this;
  };
  h.remove = function (p) {
    if (!idxSwapRemove(this.children, p)) return this;
    p.parent = null;
    p.dispatchEvent(_bbEvRemoved);
    return this;
  };
  return h;
}
const BB_HOLDER = makePartsHolder('bldgPartsHolder');
// 部品をシーンへ載せる。BBPartはholderへ、?nobatch=1 の通常Meshは従来どおりscene
function bbAttach(p) {
  if (p.isBBPart) BB_HOLDER.add(p); else scene.add(p);
}
const _bbCells = new Map();       // "cx,cz" -> { key, batches: Map(key -> batch), box }
const BB_FACADE_MATS = new Map(); // 外壁の種類 -> インスタンス描画用マテリアル(applyTimeOfDayが発光を更新)
const _bbTplMats = new Map();     // バッチキー -> テンプレートマテリアル(色は白。色はaColで掛ける)
const _bbBaseGeos = new Map();
const _bbFrustum = new THREE.Frustum();
const _bbPV = new THREE.Matrix4();
const _bbV = new THREE.Vector3();
let _bbInst = 0;

class BBPart extends THREE.Object3D {
  constructor(geo, mat) {
    super();
    this.geometry = geo;
    this.material = mat;
    this.matrixAutoUpdate = false;
    this.visible = false; // 描画はまとめ描画側。シーン走査ではすぐ読み飛ばされる
    this.isBBPart = true;
    this._bb = null;      // { b: バッチ, i: インスタンス番号 }
    this.addEventListener('added', _bbOnAdded);
    this.addEventListener('removed', _bbOnRemoved);
  }
}
function _bbOnAdded() { _bbRegister(this); }
function _bbOnRemoved() { _bbUnregister(this); }

// 共有形状で、透過なし・独自シェーダーなし(外壁は専用経路)の部品だけをまとめる。それ以外は従来のMesh
function bbMakePart(geo, mat) {
  if (BB_ON && geo && geo.userData && geo.userData.shared && mat && !Array.isArray(mat) && !mat.transparent &&
      ((mat.userData && mat.userData.facadeV2) || mat.onBeforeCompile === THREE.Material.prototype.onBeforeCompile))
    return new BBPart(geo, mat);
  return new THREE.Mesh(geo, mat);
}

function _bbKeyFor(p) {
  const m = p.material;
  if (m.userData && m.userData.facadeV2) return 'F:' + m.userData.kind;
  return p.geometry.uuid + '|' + [m.type, m.map ? m.map.uuid : '-', m.emissiveMap ? m.emissiveMap.uuid : '-',
    m.emissive ? m.emissive.getHex() : '-', m.side, m.alphaTest || 0].join(',');
}

const BB_FACADE_VS_UV = `
float fRoleV = aFace.x;
float fColsV = fRoleV < 1.5 ? aObj.z : aObj.w;
vUv = fRoleV < 3.5 ? uv * vec2(fColsV, aCol.w) : vec2(0.0);
vFace = vec3(fRoleV, fColsV, aCol.w);
vObjPos = vec3(aObj.x, 0.0, aObj.y);
vTint = aCol.rgb;
`;
// 外壁(インスタンス版)。part2.jsのFACADE_*を流用し、壁色はvTint、列数・階数・建物位置はインスタンス属性から取る
function _bbFacadeOBC(shader) {
  shader.uniforms.uLitRatio = FACADE_U.uLitRatio;
  shader.uniforms.uSkyRefl = FACADE_U.uSkyRefl;
  shader.uniforms.uDoorOnce = { value: this.userData && this.userData.doorOnce ? 1 : 0 };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 aFace;\nattribute vec4 aObj;\nattribute vec4 aCol;\nvarying vec3 vFace;\nvarying vec3 vObjPos;\nvarying vec3 vViewDirV;\nvarying vec3 vNrmV;\nvarying vec3 vTint;\n')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + BB_FACADE_VS_UV)
    .replace('#include <project_vertex>', '#include <project_vertex>\n' + FACADE_VS_PROJ);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + FACADE_FS_DECL + 'varying vec3 vTint;\n')
    .replace('#include <map_fragment>', FACADE_FS_MAP.replace(/\bdiffuse\b/g, 'vTint'))
    .replace('#include <emissivemap_fragment>', FACADE_FS_EMI);
}
// 汎用の部品(屋根・付属物など)。元のマテリアルの色をインスタンスごとに掛ける
function _bbGenericOBC(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 aCol;\nvarying vec3 vTint;\n')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTint = aCol.rgb;\n');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vTint;\n')
    .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vTint;\n');
}

function _bbTemplate(p, key) {
  let t = _bbTplMats.get(key);
  if (t) return t;
  const m = p.material;
  if (m.userData && m.userData.facadeV2) {
    const kind = m.userData.kind, at = _facadeAtlasFor(kind);
    t = new THREE.MeshLambertMaterial({ map: at.map, emissive: 0xffffff, emissiveMap: at.aux, emissiveIntensity: FACADE_U.emiNow });
    t.extensions = { derivatives: true, shaderTextureLOD: true };
    t.userData.doorOnce = !!m.userData.doorOnce;
    t.onBeforeCompile = _bbFacadeOBC;
    BB_FACADE_MATS.set(kind, t);
  } else {
    t = m.clone();
    if (t.color) t.color.setRGB(1, 1, 1);
    t.onBeforeCompile = _bbGenericOBC;
    t.userData = { src: m }; // 発光の強さは元マテリアルに追従させる(bbUpdate)
  }
  _bbTplMats.set(key, t);
  return t;
}

// 【2026-11-10・H-1】外形ポリゴンの建物(part3.js _addPolyBody。road-batchで結合する固有形状)用の外壁マテリアル。
// 箱の建物のインスタンス版と同じもの(列数・階数・壁色・建物位置は頂点属性aObj/aColで渡す)
function bbFacadeTpl(kind) {
  const key = 'F:' + kind;
  return _bbTplMats.get(key) || _bbTemplate({ material: { userData: { facadeV2: true, kind, doorOnce: kind === 'house' || kind === 'apt' } } }, key);
}
function _bbBaseGeo(p) {
  const isF = !!(p.material.userData && p.material.userData.facadeV2);
  const gk = isF ? 'F' : p.geometry.uuid;
  let g = _bbBaseGeos.get(gk);
  if (g) return g;
  if (isF) { g = new THREE.BoxGeometry(1, 1, 1); _setBoxFaceAttr(g, 1, 1, 1); }
  else g = p.geometry;
  _bbBaseGeos.set(gk, g);
  return g;
}
function _bbMakeGeo(base, cap) {
  const g = new THREE.BufferGeometry();
  for (const name of Object.keys(base.attributes)) g.setAttribute(name, base.attributes[name].clone());
  if (base.index) g.setIndex(base.index.clone());
  g.setAttribute('aObj', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aCol', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7); // カリングはセル単位で自前に行う
  return g;
}
function _bbNewMesh(b, g, cap) {
  const mesh = new THREE.InstancedMesh(g, b.mat, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = b.n; mesh.frustumCulled = false; mesh.renderOrder = 2;
  return mesh;
}
function _bbBatch(cell, key, p) {
  let b = cell.batches.get(key);
  if (b) return b;
  b = { key, cell, base: _bbBaseGeo(p), mat: _bbTemplate(p, key), mesh: null, cap: 32, n: 0, owners: [], dirty: false, dMin: Infinity, dMax: -1 };
  b.mesh = _bbNewMesh(b, _bbMakeGeo(b.base, b.cap), b.cap);
  BB_ROOT.add(b.mesh);
  cell.batches.set(key, b);
  return b;
}
function _bbGrow(b) {
  const cap = b.cap * 2, old = b.mesh, g = _bbMakeGeo(b.base, cap);
  g.attributes.aObj.array.set(old.geometry.attributes.aObj.array);
  g.attributes.aCol.array.set(old.geometry.attributes.aCol.array);
  const mesh = _bbNewMesh(b, g, cap);
  mesh.instanceMatrix.array.set(old.instanceMatrix.array);
  mesh.visible = old.visible;
  BB_ROOT.remove(old); old.geometry.dispose(); if (old.dispose) old.dispose();
  BB_ROOT.add(mesh);
  b.mesh = mesh; b.cap = cap; b.dirty = true;
  b.dMin = Infinity; b.dMax = -1; // 新しいバッファは初回に丸ごと転送される
}
function _bbWrite(b, i, p) {
  p.updateMatrix();
  p.matrix.toArray(b.mesh.instanceMatrix.array, i * 16);
  const ao = b.mesh.geometry.attributes.aObj.array, ac = b.mesh.geometry.attributes.aCol.array;
  const gu = p.geometry.userData, c = p.material.color;
  ao[i * 4] = p.position.x; ao[i * 4 + 1] = p.position.z; ao[i * 4 + 2] = gu.fcx || 1; ao[i * 4 + 3] = gu.fcz || 1;
  ac[i * 4] = c ? c.r : 1; ac[i * 4 + 1] = c ? c.g : 1; ac[i * 4 + 2] = c ? c.b : 1; ac[i * 4 + 3] = gu.ffl || 1;
  b.dirty = true;
  if (i < b.dMin) b.dMin = i;
  if (i > b.dMax) b.dMax = i;
  const s = p.scale, r = Math.max(Math.abs(s.x), Math.abs(s.z)) * 0.75 + 2, hy = Math.abs(s.y) + 2;
  b.cell.box.expandByPoint(_bbV.set(p.position.x - r, p.position.y - hy, p.position.z - r));
  b.cell.box.expandByPoint(_bbV.set(p.position.x + r, p.position.y + hy, p.position.z + r));
}
function _bbRegister(p) {
  if (p._bb) return;
  const ck = Math.floor(p.position.x / BB_CELL) + ',' + Math.floor(p.position.z / BB_CELL);
  let cell = _bbCells.get(ck);
  if (!cell) { cell = { key: ck, batches: new Map(), box: new THREE.Box3() }; _bbCells.set(ck, cell); }
  const b = _bbBatch(cell, _bbKeyFor(p), p);
  if (b.n >= b.cap) _bbGrow(b);
  const i = b.n++;
  b.owners[i] = p;
  p._bb = { b, i };
  _bbWrite(b, i, p);
  b.mesh.count = b.n;
  _bbInst++;
}
function _bbUnregister(p) {
  const h = p._bb;
  if (!h) return;
  p._bb = null;
  const b = h.b, i = h.i, last = b.n - 1;
  if (i !== last) { // 末尾のインスタンスを空いた番号へ詰める
    const q = b.owners[last];
    b.mesh.instanceMatrix.array.copyWithin(i * 16, last * 16, last * 16 + 16);
    b.mesh.geometry.attributes.aObj.array.copyWithin(i * 4, last * 4, last * 4 + 4);
    b.mesh.geometry.attributes.aCol.array.copyWithin(i * 4, last * 4, last * 4 + 4);
    b.owners[i] = q; q._bb.i = i;
    if (i < b.dMin) b.dMin = i;
    if (i > b.dMax) b.dMax = i;
  }
  b.owners.length = last;
  b.n = last; b.mesh.count = last; b.dirty = true;
  _bbInst--;
  if (b.n === 0) {
    BB_ROOT.remove(b.mesh); b.mesh.geometry.dispose(); if (b.mesh.dispose) b.mesh.dispose();
    b.cell.batches.delete(b.key);
    if (b.cell.batches.size === 0) _bbCells.delete(b.cell.key);
  }
}
// 部品の位置・回転を変えた後に呼ぶ(まとめ描画側へ反映)
function bbSync(parts) {
  if (!BB_ON || !parts) return;
  for (const p of parts) if (p && p._bb) _bbWrite(p._bb.b, p._bb.i, p);
}
// 毎フレーム、描画の直前に呼ぶ: セル単位の視錐台カリングと、変更のあったインスタンス属性の転送
function bbUpdate() {
  if (!BB_ON) return;
  camera.updateMatrixWorld();
  _bbPV.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _bbFrustum.setFromProjectionMatrix(_bbPV);
  for (const cell of _bbCells.values()) {
    const vis = !cell.box.isEmpty() && _bbFrustum.intersectsBox(cell.box);
    for (const b of cell.batches.values()) {
      b.mesh.visible = vis;
      if (b.dirty) {
        // 変わったインスタンスの範囲だけを転送する(丸ごとだと大きなバッチで1フレーム数MBになる)
        if (b.dMax >= b.dMin) {
          const n = b.dMax - b.dMin + 1, im = b.mesh.instanceMatrix, ga = b.mesh.geometry.attributes;
          im.updateRange.offset = b.dMin * 16; im.updateRange.count = n * 16; im.needsUpdate = true;
          ga.aObj.updateRange.offset = b.dMin * 4; ga.aObj.updateRange.count = n * 4; ga.aObj.needsUpdate = true;
          ga.aCol.updateRange.offset = b.dMin * 4; ga.aCol.updateRange.count = n * 4; ga.aCol.needsUpdate = true;
        }
        b.dirty = false; b.dMin = Infinity; b.dMax = -1;
      }
    }
  }
  for (const t of _bbTplMats.values()) {
    const s = t.userData && t.userData.src;
    if (s && s.emissiveIntensity !== t.emissiveIntensity) t.emissiveIntensity = s.emissiveIntensity;
  }
}
function bbStats() {
  let nb = 0;
  for (const c of _bbCells.values()) nb += c.batches.size;
  return 'batch ' + nb + '  inst ' + _bbInst + '  cell ' + _bbCells.size;
}
