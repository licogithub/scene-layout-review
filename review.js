'use strict';
const viewFlags = ['showObjects', 'showIds', 'showTargets', 'showOverlap'];
let restoringView = true, scrollTimer, toastTimer;

function parseViewState(hash = location.hash) {
 const p = new URLSearchParams(hash.replace(/^#/, ''));
 const chosenLevel = DATA.levels.find(l => String(l.id) === p.get('level')) || DATA.levels.find(l => l.available);
 const chosenCandidate = Object.hasOwn(DATA.candidates, p.get('candidate')) ? p.get('candidate') : 'A';
 const rows = chosenLevel.available ? DATA.candidates[chosenCandidate].instances : [];
 const number = (key, fallback, min, max) => {
  if (!p.has(key) || p.get(key).trim() === '') return fallback;
  const n = Number(p.get(key));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
 };
 return {
  level: chosenLevel.id, candidate: chosenCandidate,
  instance: rows.some(r => r.instance_id === p.get('instance')) ? p.get('instance') : null,
  type: Object.hasOwn(chosenLevel.counts, p.get('type')) ? p.get('type') : null,
  zoom: number('zoom', 1, .5, 8), cx: number('cx', .5, 0, 1), cy: number('cy', .5, 0, 1),
  flags: viewFlags.map((id, i) => p.has(id) ? p.get(id) === '1' : i === 0),
  revision: p.get('v') || DATA.meta.revision
 };
}

function showVersion(state) {
 const notice = $('versionNotice');
 notice.hidden = state.revision === DATA.meta.revision;
 notice.textContent = notice.hidden ? '' : '该链接引用了其他布局版本。当前显示 ' + DATA.meta.date + ' / ' + DATA.meta.revision + '；请核对讨论版本。';
}

function viewportCenter() {
 const rect = scene.getBoundingClientRect(), vr = view.getBoundingClientRect();
 return {
  cx: Math.min(1, Math.max(0, (vr.left + view.clientWidth / 2 - rect.left) / (rect.width || 1))),
  cy: Math.min(1, Math.max(0, (vr.top + view.clientHeight / 2 - rect.top) / (rect.height || 1)))
 };
}

function currentViewHash() {
 const p = new URLSearchParams({v: DATA.meta.revision, level: String(level.id), candidate});
 if (selected) p.set('instance', selected);
 if (typeHighlight) p.set('type', typeHighlight);
 for (const id of viewFlags) p.set(id, $(id).checked ? '1' : '0');
 p.set('zoom', zoom.toFixed(3));
 if (level.available) {
  const center = viewportCenter();
  p.set('cx', center.cx.toFixed(4)); p.set('cy', center.cy.toFixed(4));
 }
 return '#' + p.toString();
}

function syncShareState() {
 if (restoringView || !$('loading').hidden) return;
 const hash = currentViewHash();
 if (hash !== location.hash) history.replaceState(null, '', location.pathname + location.search + hash);
}

async function restoreViewState(state) {
 selected = state.instance; typeHighlight = selected ? null : state.type; zoom = state.zoom;
 viewFlags.forEach((id, i) => $(id).checked = state.flags[i]);
 renderCounts(); renderInspector(); draw(); updateSize();
 await new Promise(resolve => requestAnimationFrame(resolve));
 const rect = scene.getBoundingClientRect(), vr = view.getBoundingClientRect();
 view.scrollLeft += rect.left + rect.width * state.cx - vr.left - view.clientWidth / 2;
 view.scrollTop += rect.top + rect.height * state.cy - vr.top - view.clientHeight / 2;
 showVersion(state);
}

function toast(message) {
 clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
 toastTimer = setTimeout(() => $('toast').hidden = true, 3200);
}

async function copyText(text, message) {
 let clipboardTimer;
 try {
  await Promise.race([
   navigator.clipboard.writeText(text),
   new Promise((resolve, reject) => { clipboardTimer = setTimeout(() => reject(new Error('clipboard timeout')), 1500); })
  ]);
  toast(message);
 } catch {
  $('copyText').value = text;
  $('copyDialog').showModal(); $('copyText').focus(); $('copyText').select();
 } finally { clearTimeout(clipboardTimer); }
}

function viewURL() {
 return location.origin + location.pathname + location.search + currentViewHash();
}

$('shareView').onclick = () => copyText(viewURL(), '已复制视图链接，可发给同事打开');
$('copyDiscussion').onclick = () => {
 const row = report?.instances.find(r => r.instance_id === selected);
 const lines = ['场景布局审阅 · ' + level.name + (level.available ? ' / ' + candidate + ' ' + DATA.candidates[candidate].name : ' / 资源待接入'),
  '版本：' + DATA.meta.date + ' / ' + DATA.meta.revision];
 if (row) lines.push('物件：' + row.name + ' / ' + row.instance_id,
  '左上角：' + row.bbox.slice(0, 2).join(', ') + '；前景保留：' + (row.visibility * 100).toFixed(2) + '%');
 else if (typeHighlight) lines.push('高亮素材：' + assetName(typeHighlight));
 if (report) lines.push('数量：' + report.renderedTotal + ' / ' + report.expectedTotal + '；额外遮挡：' + report.unexpectedOverlapPairs.length + ' 对');
 lines.push('查看位置：' + viewURL());
 copyText(lines.join('\n'), '已复制讨论摘要及位置链接');
};

view.addEventListener('scroll', () => {
 clearTimeout(scrollTimer); scrollTimer = setTimeout(syncShareState, 180);
}, {passive: true});
for (const id of ['zoomIn', 'zoomOut', 'fit']) {
 $(id).addEventListener('click', () => requestAnimationFrame(syncShareState));
}
window.addEventListener('hashchange', async () => {
 const state = parseViewState(); restoringView = true;
 level = DATA.levels.find(l => l.id === state.level); candidate = state.candidate; $('level').value = level.id;
 await switchScene(state); showVersion(state); restoringView = false; syncShareState();
});

const initialViewState = parseViewState();
level = DATA.levels.find(l => l.id === initialViewState.level); candidate = initialViewState.candidate;
$('revisionBadge').textContent = DATA.meta.date + ' · ' + DATA.meta.revision.slice(0, 6);
$('revisionBadge').title = '布局版本 ' + DATA.meta.revision;
showVersion(initialViewState);
init().then(() => { restoringView = false; syncShareState(); });
