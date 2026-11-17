'use strict';
// ===================================================================== 状態
const S = {
  items: [],          // [{id, file, status, note}]
  cur: null,          // 現在の画像ID
  st: null,           // 表構造 {rows, cols, header_rows, merges:[[r,c,rs,cs],...]}
  savedKey: null,     // 保存済み状態の比較用
  undo: [], redo: [],
  anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 },
  lastSaved: null,    // 直前に保存した構造（コピー用）
};
const DEFAULT = { rows: 5, cols: 4, header_rows: 1, merges: [] };
const $ = id => document.getElementById(id);
const clone = o => JSON.parse(JSON.stringify(o));
const colName = c => { let s = ''; c += 1; while (c) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1800); }
async function api(url, opt) {
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => null);
  if (!r.ok && !(j && j.errors)) throw new Error(`${r.status} ${url}`);
  return j;
}

// ===================================================================== 構造の操作（純粋関数）
function normMerges(st) {
  st.merges = st.merges.filter(([r, c, rs, cs]) => rs >= 1 && cs >= 1 && !(rs === 1 && cs === 1));
  st.merges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return st;
}
function cellMap(st) {
  // owner[r][c] = 結合のindex または -1
  const own = Array.from({ length: st.rows }, () => new Array(st.cols).fill(-1));
  st.merges.forEach(([r, c, rs, cs], i) => {
    for (let rr = r; rr < Math.min(r + rs, st.rows); rr++)
      for (let cc = c; cc < Math.min(c + cs, st.cols); cc++) own[rr][cc] = i;
  });
  return own;
}
function selRect() {
  const a = S.anchor, f = S.focus;
  return { r0: Math.min(a.r, f.r), r1: Math.max(a.r, f.r), c0: Math.min(a.c, f.c), c1: Math.max(a.c, f.c) };
}
function expandRect(st, rc) {
  // 結合セルに一部でもかかっていれば、その結合全体を含むまで広げる
  let { r0, r1, c0, c1 } = rc, changed = true;
  while (changed) {
    changed = false;
    for (const [r, c, rs, cs] of st.merges) {
      const re = r + rs - 1, ce = c + cs - 1;
      if (r <= r1 && re >= r0 && c <= c1 && ce >= c0) {
        if (r < r0) { r0 = r; changed = true; }
        if (re > r1) { r1 = re; changed = true; }
        if (c < c0) { c0 = c; changed = true; }
        if (ce > c1) { c1 = ce; changed = true; }
      }
    }
  }
  return { r0, r1, c0, c1 };
}
function opMerge(st, rc) {
  if (rc.r0 === rc.r1 && rc.c0 === rc.c1) throw '2つ以上のセルを選択してください';
  if (rc.r0 < st.header_rows && rc.r1 >= st.header_rows) throw '見出しと本文をまたぐ結合はできません';
  st.merges = st.merges.filter(([r, c, rs, cs]) => !(r >= rc.r0 && r + rs - 1 <= rc.r1 && c >= rc.c0 && c + cs - 1 <= rc.c1));
  st.merges.push([rc.r0, rc.c0, rc.r1 - rc.r0 + 1, rc.c1 - rc.c0 + 1]);
  return normMerges(st);
}
function opUnmerge(st, rc) {
  const n = st.merges.length;
  st.merges = st.merges.filter(([r, c, rs, cs]) => !(r <= rc.r1 && r + rs - 1 >= rc.r0 && c <= rc.c1 && c + cs - 1 >= rc.c0));
  if (st.merges.length === n) throw '選択範囲に結合セルがありません';
  return st;
}
function insRow(st, i, intoHeader) {
  // i 行目の位置に新しい行を挿入（i は 0..rows）
  st.merges.forEach(m => { if (m[0] >= i) m[0] += 1; else if (m[0] + m[2] > i) m[2] += 1; });
  if (i < st.header_rows || (intoHeader && i === st.header_rows)) st.header_rows += 1;
  st.rows += 1;
  return normMerges(st);
}
function delRow(st, i) {
  st.merges.forEach(m => { if (m[0] > i) m[0] -= 1; else if (m[0] + m[2] > i) m[2] -= 1; });
  if (i < st.header_rows) st.header_rows -= 1;
  st.rows -= 1;
  return normMerges(st);
}
function insCol(st, j) {
  st.merges.forEach(m => { if (m[1] >= j) m[1] += 1; else if (m[1] + m[3] > j) m[3] += 1; });
  st.cols += 1;
  return normMerges(st);
}
function delCol(st, j) {
  st.merges.forEach(m => { if (m[1] > j) m[1] -= 1; else if (m[1] + m[3] > j) m[3] -= 1; });
  st.cols -= 1;
  return normMerges(st);
}
function resize(st, R, C) {
  st.rows = R; st.cols = C;
  st.merges = st.merges.filter(m => m[0] < R && m[1] < C)
    .map(([r, c, rs, cs]) => [r, c, Math.min(rs, R - r), Math.min(cs, C - c)]);
  st.header_rows = Math.min(st.header_rows, R);
  return normMerges(st);
}
function setHeader(st, h) {
  h = Math.max(0, Math.min(st.rows, h));
  const bad = st.merges.find(([r, , rs]) => r < h && r + rs > h);
  if (bad) throw `${bad[0] + 1}行目からの縦結合が見出しの境界をまたぐため、見出し行数を${h}にできません`;
  st.header_rows = h;
  return st;
}

// ===================================================================== 変更の適用・履歴
function key() { return JSON.stringify([S.st, $('noteIn').value]); }
function isDirty() { return S.cur && S.savedKey !== key(); }
function change(fn) {
  const before = clone(S.st);
  try {
    const next = fn(clone(S.st));
    S.undo.push(before); if (S.undo.length > 300) S.undo.shift();
    S.redo = [];
    S.st = next;
    clampSel();
    render();
  } catch (e) {
    if (typeof e === 'string') showMsg([{ cls: 'err', t: e }]); else throw e;
  }
}
function undo() { if (!S.undo.length) return; S.redo.push(clone(S.st)); S.st = S.undo.pop(); clampSel(); render(); }
function redo() { if (!S.redo.length) return; S.undo.push(clone(S.st)); S.st = S.redo.pop(); clampSel(); render(); }
function clampSel() {
  for (const p of [S.anchor, S.focus]) { p.r = Math.max(0, Math.min(S.st.rows - 1, p.r)); p.c = Math.max(0, Math.min(S.st.cols - 1, p.c)); }
}

// ===================================================================== 描画
function render() {
  const st = S.st, grid = $('grid');
  const own = cellMap(st);
  let h = '<thead><tr><th class="corner"></th>';
  for (let c = 0; c < st.cols; c++) h += `<th data-col="${c}">${colName(c)}</th>`;
  h += '</tr></thead><tbody>';
  for (let r = 0; r < st.rows; r++) {
    const last = st.header_rows > 0 && r === st.header_rows - 1;
    h += `<tr class="${last ? 'head-last' : ''}"><th data-row="${r}">${r + 1}${r < st.header_rows ? '<small>見</small>' : ''}</th>`;
    for (let c = 0; c < st.cols; c++) {
      const mi = own[r][c];
      let attrs = '', cls = [], label = '';
      if (mi >= 0) {
        const [mr, mc, rs, cs] = st.merges[mi];
        if (mr !== r || mc !== c) continue;
        if (rs > 1) attrs += ` rowspan="${rs}"`;
        if (cs > 1) attrs += ` colspan="${cs}"`;
        cls.push('merged'); label = `${rs}×${cs}`;
      }
      if (r < st.header_rows) cls.push('head');
      h += `<td data-r="${r}" data-c="${c}"${attrs} class="${cls.join(' ')}">${label}</td>`;
    }
    h += '</tr>';
  }
  grid.innerHTML = h + '</tbody>';
  S._own = own;
  $('rowsIn').value = st.rows; $('colsIn').value = st.cols; $('headIn').value = st.header_rows; $('headIn').max = st.rows;
  $('undoBtn').disabled = !S.undo.length; $('redoBtn').disabled = !S.redo.length;
  $('copyPrevBtn').disabled = !S.lastSaved;
  paintSel();
  updateStatusBadge();
  scheduleCheck();
}
// 選択範囲の表示だけを更新（DOMは作り直さない）
function paintSel() {
  const st = S.st, own = S._own || cellMap(st), grid = $('grid');
  const rc = expandRect(st, selRect());
  let fr = S.focus.r, fc = S.focus.c;
  if (own[fr] && own[fr][fc] >= 0) { const m = st.merges[own[fr][fc]]; fr = m[0]; fc = m[1]; }
  grid.querySelectorAll('td').forEach(td => {
    const r = +td.dataset.r, c = +td.dataset.c;
    td.classList.toggle('sel', r >= rc.r0 && r <= rc.r1 && c >= rc.c0 && c <= rc.c1);
    td.classList.toggle('focus', r === fr && c === fc);
  });
  grid.querySelectorAll('th[data-col]').forEach(th => { const c = +th.dataset.col; th.classList.toggle('sel', c >= rc.c0 && c <= rc.c1); });
  grid.querySelectorAll('th[data-row]').forEach(th => { const r = +th.dataset.row; th.classList.toggle('sel', r >= rc.r0 && r <= rc.r1); });
  const selTxt = `${colName(rc.c0)}${rc.r0 + 1}` + (rc.r0 === rc.r1 && rc.c0 === rc.c1 ? '' : `:${colName(rc.c1)}${rc.r1 + 1}`);
  $('info').innerHTML = `行 <b>${st.rows}</b>　列 <b>${st.cols}</b>　結合 <b>${st.merges.length}</b>　見出し <b>${st.header_rows}</b> 行　セル数 <b>${countCells(st, own)}</b>　｜　選択 ${selTxt}（${rc.r1 - rc.r0 + 1}×${rc.c1 - rc.c0 + 1}）`;
}
function countCells(st, own) { let n = 0; for (let r = 0; r < st.rows; r++) for (let c = 0; c < st.cols; c++) { const mi = own[r][c]; if (mi < 0 || (st.merges[mi][0] === r && st.merges[mi][1] === c)) n++; } return n; }

let checkTimer = null;
function scheduleCheck() { clearTimeout(checkTimer); checkTimer = setTimeout(runCheck, 150); }
async function runCheck() {
  if (!S.cur) return;
  const j = await api('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S.st) });
  $('htmlPreview').textContent = j.html || '（エラーがあるため生成できません）';
  const msgs = j.errors.map(t => ({ cls: 'err', t: '✕ ' + t })).concat(j.warnings.map(t => ({ cls: 'warn', t: '⚠ ' + t })));
  showMsg(msgs.length ? msgs : [{ cls: 'ok', t: '✓ 構造に問題はありません' }]);
}
function showMsg(list) { $('messages').innerHTML = list.map(m => `<div class="${m.cls}">${escapeHtml(m.t)}</div>`).join(''); }
function escapeHtml(s) { return s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

// ===================================================================== 一覧・読み込み・保存
async function loadList() {
  const j = await api('/api/images');
  S.items = j.items;
  if (j.duplicates.length) toast(`拡張子違いの同名ファイルを無視: ${j.duplicates.join(', ')}`);
  renderList();
}
function filtered() {
  const f = $('filter').value, q = $('search').value.trim().toLowerCase();
  return S.items.filter(it => (f === 'all' || it.status === f) && (!q || it.file.toLowerCase().includes(q)));
}
function renderList() {
  const ul = $('imgList');
  ul.innerHTML = filtered().map(it => `<li data-id="${escapeHtml(it.id)}" class="${it.id === S.cur ? 'active' : ''}" title="${escapeHtml(it.file + (it.note ? '\n' + it.note : ''))}"><span class="dot ${it.status}"></span><span class="fn">${escapeHtml(it.file)}</span>${it.note ? '<span class="memo">✎</span>' : ''}</li>`).join('');
  const done = S.items.filter(i => i.status === 'done').length, sk = S.items.filter(i => i.status === 'skipped').length;
  $('progress').textContent = `作成済み ${done} / ${S.items.length}（スキップ ${sk}・未着手 ${S.items.length - done - sk}）`;
  const a = ul.querySelector('li.active'); if (a) a.scrollIntoView({ block: 'nearest' });
}
function curItem() { return S.items.find(i => i.id === S.cur); }
function updateStatusBadge() {
  const it = curItem(), b = $('curStatus');
  if (!it) { b.className = 'badge'; b.textContent = ''; return; }
  b.className = `badge ${it.status}` + (isDirty() ? ' dirty' : '');
  b.textContent = { todo: '未着手', done: '作成済み', skipped: 'スキップ' }[it.status];
}
async function openImage(id) {
  if (id === S.cur) return;
  if (isDirty() && !confirm('保存していない変更があります。破棄して移動しますか？')) return;
  const it = S.items.find(i => i.id === id); if (!it) return;
  const rec = await api(`/api/annotation/${encodeURIComponent(id)}`);
  S.cur = id;
  S.st = rec && rec.structure ? clone(rec.structure) : clone(DEFAULT);
  if (rec && rec.status === 'skipped' && rec.structure && rec.structure.rows === 1 && rec.structure.cols === 1) S.st = clone(DEFAULT);
  $('noteIn').value = rec ? (rec.note || '') : '';
  S.undo = []; S.redo = []; S.anchor = { r: 0, c: 0 }; S.focus = { r: 0, c: 0 };
  S.savedKey = key();
  $('curName').textContent = it.file;
  loadImg(id);
  renderList(); render();
}
async function save(status, goNext) {
  if (!S.cur) return;
  const body = { structure: S.st, status, note: $('noteIn').value };
  const j = await api(`/api/annotation/${encodeURIComponent(S.cur)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!j.ok) { showMsg(j.errors.map(t => ({ cls: 'err', t: '✕ 保存できません: ' + t }))); return false; }
  const it = curItem(); it.status = status; it.note = body.note;
  S.savedKey = key();
  if (status === 'done') S.lastSaved = clone(S.st);
  renderList(); updateStatusBadge();
  toast(status === 'done' ? `保存しました（学習データ ${j.export.exported} 件）` : 'スキップとして記録しました');
  if (j.warnings.length) showMsg(j.warnings.map(t => ({ cls: 'warn', t: '⚠ ' + t })));
  if (goNext) gotoRel(1, true);
  return true;
}
function gotoRel(d, preferTodo) {
  const list = filtered(); if (!list.length) return;
  let i = list.findIndex(x => x.id === S.cur);
  if (preferTodo) {
    for (let k = 1; k <= list.length; k++) { const x = list[(i + k) % list.length]; if (x.status === 'todo') return openImage(x.id); }
  }
  i = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + d));
  openImage(list[i].id);
}

// ===================================================================== 画像ビューア
const V = { scale: 1, x: 0, y: 0, nw: 0, nh: 0 };
function loadImg(id) {
  const img = $('img');
  $('noImage').style.display = 'none';
  img.onload = () => { V.nw = img.naturalWidth; V.nh = img.naturalHeight; img.style.width = V.nw + 'px'; img.style.height = V.nh + 'px'; fit('all'); };
  img.src = `/image/${encodeURIComponent(id)}?t=${Date.now()}`;
}
function applyView() {
  $('img').style.transform = `translate(${V.x}px, ${V.y}px) scale(${V.scale})`;
  $('img').classList.toggle('pixel', V.scale >= 3);
  $('zoomLabel').textContent = Math.round(V.scale * 100) + '%';
}
function fit(mode) {
  const vw = $('viewer').clientWidth, vh = $('viewer').clientHeight; if (!V.nw) return;
  const m = 12;
  V.scale = mode === 'width' ? (vw - 2 * m) / V.nw : mode === '1' ? 1 : Math.min((vw - 2 * m) / V.nw, (vh - 2 * m) / V.nh);
  V.x = (vw - V.nw * V.scale) / 2; V.y = mode === 'width' ? m : (vh - V.nh * V.scale) / 2;
  if (mode === '1') { V.x = Math.max(m, V.x); V.y = Math.max(m, V.y); }
  applyView();
}
(function viewerEvents() {
  const vw = $('viewer'); let drag = null;
  vw.addEventListener('wheel', e => {
    e.preventDefault(); if (!V.nw) return;
    const rect = vw.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top;
    const f = Math.exp(-e.deltaY * 0.0015), ns = Math.max(0.05, Math.min(20, V.scale * f));
    V.x = px - (px - V.x) * ns / V.scale; V.y = py - (py - V.y) * ns / V.scale; V.scale = ns; applyView();
  }, { passive: false });
  vw.addEventListener('mousedown', e => { if (e.button !== 0) return; drag = { sx: e.clientX, sy: e.clientY, x: V.x, y: V.y }; vw.classList.add('dragging'); });
  window.addEventListener('mousemove', e => {
    if (drag) { V.x = drag.x + e.clientX - drag.sx; V.y = drag.y + e.clientY - drag.sy; applyView(); }
    const rect = vw.getBoundingClientRect(), inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    const show = inside && $('guideChk').checked && V.nw;
    $('guideH').style.display = $('guideV').style.display = show ? 'block' : 'none';
    if (show) { $('guideH').style.top = (e.clientY - rect.top) + 'px'; $('guideV').style.left = (e.clientX - rect.left) + 'px'; }
  });
  window.addEventListener('mouseup', () => { drag = null; vw.classList.remove('dragging'); });
  window.addEventListener('resize', () => { if (V.nw) applyView(); });
})();

// ===================================================================== グリッドのマウス操作
(function gridEvents() {
  const g = $('grid'); let mode = null;
  const cellOf = el => { const td = el.closest('td'); return td ? { r: +td.dataset.r, c: +td.dataset.c } : null; };
  g.addEventListener('mousedown', e => {
    e.preventDefault(); $('gridWrap').focus();
    const th = e.target.closest('th'), cell = cellOf(e.target);
    if (cell) {
      mode = 'cell';
      if (!e.shiftKey) S.anchor = { ...cell };
      S.focus = { ...cell };
    } else if (th && th.dataset.row !== undefined) {
      mode = 'row'; const r = +th.dataset.row;
      if (!e.shiftKey) S.anchor = { r, c: 0 };
      S.focus = { r, c: S.st.cols - 1 }; S.anchor.c = 0;
    } else if (th && th.dataset.col !== undefined) {
      mode = 'col'; const c = +th.dataset.col;
      if (!e.shiftKey) S.anchor = { r: 0, c };
      S.focus = { r: S.st.rows - 1, c }; S.anchor.r = 0;
    } else if (th && th.classList.contains('corner')) {
      S.anchor = { r: 0, c: 0 }; S.focus = { r: S.st.rows - 1, c: S.st.cols - 1 }; mode = null;
    }
    paintSel();
  });
  g.addEventListener('mouseover', e => {
    if (!mode || !(e.buttons & 1)) { mode = null; return; }
    const th = e.target.closest('th'), cell = cellOf(e.target);
    let nf = null;
    if (mode === 'cell' && cell) nf = { ...cell };
    else if (mode === 'row' && th && th.dataset.row !== undefined) nf = { r: +th.dataset.row, c: S.st.cols - 1 };
    else if (mode === 'col' && th && th.dataset.col !== undefined) nf = { r: S.st.rows - 1, c: +th.dataset.col };
    if (!nf || (nf.r === S.focus.r && nf.c === S.focus.c)) return;
    S.focus = nf;
    paintSel();
  });
  window.addEventListener('mouseup', () => { mode = null; });
})();

// ===================================================================== コマンド
const cmd = {
  merge: () => change(st => opMerge(st, expandRect(st, selRect()))),
  unmerge: () => change(st => opUnmerge(st, expandRect(st, selRect()))),
  insRowAbove: () => { const rc = expandRect(S.st, selRect()); change(st => insRow(st, rc.r0, rc.r0 < st.header_rows)); },
  insRowBelow: () => {
    const rc = expandRect(S.st, selRect());
    change(st => insRow(st, rc.r1 + 1, rc.r1 < st.header_rows));
    S.anchor = { r: Math.min(rc.r1 + 1, S.st.rows - 1), c: S.anchor.c }; S.focus = { ...S.anchor }; paintSel();
  },
  insColLeft: () => { const rc = expandRect(S.st, selRect()); change(st => insCol(st, rc.c0)); },
  insColRight: () => {
    const rc = expandRect(S.st, selRect());
    change(st => insCol(st, rc.c1 + 1));
    S.anchor = { r: S.anchor.r, c: Math.min(rc.c1 + 1, S.st.cols - 1) }; S.focus = { ...S.anchor }; paintSel();
  },
  delRow: () => {
    const rc = selRect();
    if (rc.r1 - rc.r0 + 1 >= S.st.rows) return showMsg([{ cls: 'err', t: 'すべての行は削除できません' }]);
    change(st => { for (let r = rc.r1; r >= rc.r0; r--) delRow(st, r); return st; });
  },
  delCol: () => {
    const rc = selRect();
    if (rc.c1 - rc.c0 + 1 >= S.st.cols) return showMsg([{ cls: 'err', t: 'すべての列は削除できません' }]);
    change(st => { for (let c = rc.c1; c >= rc.c0; c--) delCol(st, c); return st; });
  },
  headToSel: () => { const rc = expandRect(S.st, selRect()); change(st => setHeader(st, rc.r1 + 1)); },
  applySize: () => {
    const R = parseInt($('rowsIn').value, 10), C = parseInt($('colsIn').value, 10);
    if (!(R >= 1 && R <= 300 && C >= 1 && C <= 100)) return showMsg([{ cls: 'err', t: '行は1〜300、列は1〜100で指定してください' }]);
    if ((R < S.st.rows || C < S.st.cols) && S.st.merges.length && !confirm('表を小さくすると、はみ出した結合は切り詰められます。続けますか？')) return;
    change(st => resize(st, R, C));
  },
  setHead: () => { const h = parseInt($('headIn').value, 10); if (Number.isFinite(h)) change(st => setHeader(st, h)); },
  copyPrev: () => { if (S.lastSaved) change(() => clone(S.lastSaved)); },
};

function moveSel(dr, dc, extend) {
  const st = S.st, own = cellMap(st);
  let { r, c } = S.focus;
  // 結合セルの中にいる場合は、結合の端から隣へ移動する
  const mi = own[r][c];
  if (mi >= 0) {
    const [mr, mc, rs, cs] = st.merges[mi];
    if (dr > 0) r = mr + rs - 1; if (dr < 0) r = mr; if (dc > 0) c = mc + cs - 1; if (dc < 0) c = mc;
  }
  r = Math.max(0, Math.min(st.rows - 1, r + dr)); c = Math.max(0, Math.min(st.cols - 1, c + dc));
  S.focus = { r, c }; if (!extend) S.anchor = { r, c };
  paintSel();
  const td = $('grid').querySelector('td.focus'); if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ===================================================================== イベント登録
function bind(id, fn) { $(id).addEventListener('click', fn); }
bind('mergeBtn', cmd.merge); bind('unmergeBtn', cmd.unmerge);
bind('insRowAboveBtn', cmd.insRowAbove); bind('insRowBelowBtn', cmd.insRowBelow);
bind('insColLeftBtn', cmd.insColLeft); bind('insColRightBtn', cmd.insColRight);
bind('delRowBtn', cmd.delRow); bind('delColBtn', cmd.delCol);
bind('undoBtn', undo); bind('redoBtn', redo); bind('copyPrevBtn', cmd.copyPrev);
bind('applySizeBtn', cmd.applySize); bind('headToSelBtn', cmd.headToSel);
$('headIn').addEventListener('change', cmd.setHead);
$('rowsIn').addEventListener('keydown', e => { if (e.key === 'Enter') cmd.applySize(); });
$('colsIn').addEventListener('keydown', e => { if (e.key === 'Enter') cmd.applySize(); });
bind('saveBtn', () => save('done', false)); bind('saveNextBtn', () => save('done', true));
bind('skipBtn', () => {
  if (!$('noteIn').value.trim()) { const r = prompt('スキップ理由（任意）', ''); if (r === null) return; $('noteIn').value = r; }
  save('skipped', true);
});
bind('prevBtn', () => gotoRel(-1)); bind('nextBtn', () => gotoRel(1));
bind('fitBtn', () => fit('all')); bind('fitWBtn', () => fit('width')); bind('z100Btn', () => fit('1'));
bind('helpBtn', () => $('help').showModal());
bind('toggleList', () => $('sidebar').classList.toggle('hidden'));
$('filter').addEventListener('change', renderList); $('search').addEventListener('input', renderList);
$('imgList').addEventListener('click', e => { const li = e.target.closest('li'); if (li) openImage(li.dataset.id); });
$('noteIn').addEventListener('input', updateStatusBadge);
$('cellSize').addEventListener('input', e => { const w = +e.target.value; $('grid').style.setProperty('--cw', w + 'px'); $('grid').style.setProperty('--ch', Math.round(w * 0.72) + 'px'); });
$('gridWrap').tabIndex = 0;

document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); save('done', false); return; }
  if (ctrl && e.key === 'Enter') { e.preventDefault(); save('done', true); return; }
  if (typing || !S.cur || $('help').open) return;
  if (e.key === 'PageDown') { e.preventDefault(); gotoRel(1); return; }
  if (e.key === 'PageUp') { e.preventDefault(); gotoRel(-1); return; }
  if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); return; }
  if (e.key === 'Delete' && e.shiftKey) { e.preventDefault(); cmd.delRow(); return; }
  if (e.key === 'Delete' && ctrl) { e.preventDefault(); cmd.delCol(); return; }
  const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  if (arrows[e.key]) { e.preventDefault(); moveSel(...arrows[e.key], e.shiftKey); return; }
  if (ctrl || e.altKey) return;
  switch (e.key) {
    case 'm': case 'M': cmd.merge(); break;
    case 'u': case 'U': cmd.unmerge(); break;
    case 'r': cmd.insRowBelow(); break;
    case 'R': cmd.insRowAbove(); break;
    case 'c': cmd.insColRight(); break;
    case 'C': cmd.insColLeft(); break;
    case 'h': case 'H': cmd.headToSel(); break;
    case 'f': case 'F': fit('all'); break;
    case 'w': case 'W': fit('width'); break;
    case '1': fit('1'); break;
    default: return;
  }
  e.preventDefault();
});
window.addEventListener('beforeunload', e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

// 左右の幅調整
(function splitter() {
  const sp = $('splitter'), vp = $('viewerPane'); let d = null;
  sp.addEventListener('mousedown', e => { d = { x: e.clientX, w: vp.offsetWidth }; e.preventDefault(); });
  window.addEventListener('mousemove', e => { if (d) vp.style.width = Math.max(200, d.w + e.clientX - d.x) + 'px'; });
  window.addEventListener('mouseup', () => { if (d) { d = null; if (V.nw) applyView(); } });
})();

// ===================================================================== 起動
(async function init() {
  S.st = clone(DEFAULT);
  render();
  await loadList();
  const first = S.items.find(i => i.status === 'todo') || S.items[0];
  if (first) openImage(first.id);
})();

// テスト用に公開
window.__TA = { S, opMerge, opUnmerge, insRow, delRow, insCol, delCol, resize, setHeader, expandRect, cellMap };
