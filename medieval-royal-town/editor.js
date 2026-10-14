'use strict';
// All changes operate on instances, never on the source art or original canyon data.
let selectedMapDrafts=structuredClone(DATA.candidates.A1.profiles);
const selectedMapUndo=new Map();
let selectedMapDrag=null,selectedMapDragged=false,selectedMapRefresh=0;
const selectedMapCacheKey=(i,p=densityProfile)=>'medieval-royal-town-layout:'+DATA.meta.revision+':'+p+':'+DATA.candidates.A1.profiles[p][i].seed;
const selectedMapUndoKey=()=>densityProfile+':'+scatterIndex;
function validSavedLayout(saved,i,p){
 const original=DATA.candidates.A1.profiles[p][i].instances;
 if(!Array.isArray(saved)||saved.length!==original.length)return false;
 return saved.every((r,n)=>r.instance_id===original[n].instance_id&&r.prototype_id===original[n].prototype_id&&r.parent_instance_id===original[n].parent_instance_id&&r.role===original[n].role&&Array.isArray(r.bbox)&&r.bbox.length===4&&r.bbox.every(Number.isFinite)&&r.bbox.every(Number.isInteger)&&r.bbox[0]>=0&&r.bbox[1]>=0&&r.bbox[2]<=4096&&r.bbox[3]<=4096&&r.bbox[2]-r.bbox[0]===DATA.assetSets[p][r.prototype_id].wh[0]&&r.bbox[3]-r.bbox[1]===DATA.assetSets[p][r.prototype_id].wh[1]&&Array.isArray(r.foot_anchor)&&r.foot_anchor.length===2&&r.foot_anchor.every(Number.isFinite)&&Number.isFinite(r.depth_y));
}
for(const [p,layouts] of Object.entries(selectedMapDrafts))for(let i=0;i<layouts.length;i++){
 try{const stored=JSON.parse(localStorage.getItem(selectedMapCacheKey(i,p))||'null'),rows=Array.isArray(stored)?stored:stored?.instances;if(validSavedLayout(rows,i,p)){selectedMapDrafts[p][i].instances=rows;selectedMapDrafts[p][i].edited=stored?.edited!==false;}}catch{}
}
currentLayouts=()=>selectedMapDrafts[densityProfile];
currentLayout=()=>selectedMapDrafts[densityProfile][scatterIndex];
const selectedMapAnalyze=analyze;
analyze=function(rows){const result=selectedMapAnalyze(rows);result.data.schema='selectedMap-layout-review.draft.v1';result.data.geometryValidation={status:'visual_trial_pending_review',railCars:rows.filter(r=>r.prototype_id==='vehicle-01').length,roadHaulers:rows.filter(r=>r.prototype_id==='vehicle-02').length};result.data.artStatus='latest_assets_visual_trial_pending_review';result.data.layoutSha256=currentLayout().edited?null:currentLayout().sha256;result.data.manuallyEdited=!!currentLayout().edited;return result;};
function selectedMapStatus(){
 $('editStatus').textContent=currentLayout().edited?'已微调 · 自动保存到当前浏览器':'初排位置';
 $('undoMove').disabled=!(selectedMapUndo.get(selectedMapUndoKey())?.length);
 const enabled=!!selected&&$('editLayout').checked&&!!report;
 for(const id of ['nudgeLeft','nudgeUp','nudgeDown','nudgeRight'])$(id).disabled=!enabled;
}
const selectedMapInspector=renderInspector;
renderInspector=function(){selectedMapInspector();selectedMapStatus();};
renderValidation=function(){
 if(!report){$('validation').innerHTML=line('精确核数','正在加载');$('occlusionList').textContent='暂无可检查的场景。';return;}
 $('validation').innerHTML=line('逐种数量',report.quantityMatched?'全部一致':'存在差异',report.quantityMatched?'good':'bad')+line('实际绘制 / 要求',report.renderedTotal+' / '+report.expectedTotal)+line('有前景可见',report.visibleTotal+' / '+report.renderedTotal,report.visibleTotal===level.total?'good':'bad')+line('目标子集',report.actualTargetTotal+' / '+report.expectedTargetTotal)+line('建筑 + 设施组合',report.declaredStackCount+' / '+level.stacks+'组')+line('额外像素遮挡',report.unexpectedOverlapPairs.length+'对',report.unexpectedOverlapPairs.length?'warn':'good')+line('画面外物件',report.outOfBounds.length+'个',report.outOfBounds.length?'bad':'good')+line('原向 / 镜向',report.facingCounts.original+' / '+report.facingCounts.mirrored)+line('预留空地',(currentLayout().checks.clearing_count||0)+'块 · '+((currentLayout().checks.reserved_empty_ground_ratio||0)*100).toFixed(1)+'%')+line('落地与路线','初排待细查','warn');
 const list=$('occlusionList');list.replaceChildren();
 for(const r of report.instances.filter(r=>r.visibility<1).sort((a,b)=>a.visibility-b.visibility)){
  const b=document.createElement('button');b.className='occlusion-row';b.textContent=instanceLabel(r)+' · '+r.name;const span=document.createElement('span');span.textContent='保留 '+(r.visibility*100).toFixed(1)+'%';b.append(span);b.onclick=()=>selectInstance(r.instance_id,true);list.append(b);
 }
 if(!list.children.length)list.textContent='没有检测到前景像素覆盖。';
 selectedMapStatus();
};
function selectedMapPaintBase(){
 drawOrder=sortedInstances(currentRows());baseCtx.clearRect(0,0,4096,4096);baseCtx.drawImage(backgrounds[candidate],0,0,4096,4096);for(const r of drawOrder)paint(baseCtx,r);draw();
}
function selectedMapRecord(){
 const undo=selectedMapUndo.get(selectedMapUndoKey())||[];undo.push(structuredClone(currentRows()));if(undo.length>30)undo.shift();selectedMapUndo.set(selectedMapUndoKey(),undo);
}
function selectedMapCommit(){
 for(const key of Object.keys(analysisCache))delete analysisCache[key];
 const a=analyze(currentRows());report=a.data;owner=a.grid;selectedMapPaintBase();renderCounts();renderValidation();renderInspector();
 try{localStorage.setItem(selectedMapCacheKey(scatterIndex),JSON.stringify({instances:currentRows(),edited:!!currentLayout().edited}));}catch{$('editStatus').textContent='浏览器未允许自动保存，请导出布局JSON';}
}
function selectedMapMove(id,dx,dy,startRows=null){
 const rows=currentRows(),start=startRows||structuredClone(rows),group=[id,...rows.filter(r=>r.parent_instance_id===id).map(r=>r.instance_id)];
 const moving=start.filter(r=>group.includes(r.instance_id));if(!moving.length)return;
 dx=Math.round(Math.max(-Math.min(...moving.map(r=>r.bbox[0])),Math.min(4096-Math.max(...moving.map(r=>r.bbox[2])),dx)));
 dy=Math.round(Math.max(-Math.min(...moving.map(r=>r.bbox[1])),Math.min(4096-Math.max(...moving.map(r=>r.bbox[3])),dy)));
 for(const origin of moving){const r=rows.find(r=>r.instance_id===origin.instance_id);r.bbox=origin.bbox.map((v,k)=>v+(k%2?dy:dx));r.foot_anchor=[origin.foot_anchor[0]+dx,origin.foot_anchor[1]+dy];r.depth_y=origin.depth_y+dy;r.manually_moved=true;}
 currentLayout().edited=true;selectedMapPaintBase();selectedMapStatus();
}
function scenePoint(e){const rect=scene.getBoundingClientRect();return [Math.floor((e.clientX-rect.left)*4096/rect.width),Math.floor((e.clientY-rect.top)*4096/rect.height)];}
scene.addEventListener('pointerdown',e=>{
 if(!$('editLayout').checked||!report||!$('showObjects').checked)return;
 const [x,y]=scenePoint(e),number=x>=0&&x<4096&&y>=0&&y<4096?owner[y*4096+x]:0;
 if(!number)return;selected=currentRows()[number-1].instance_id;typeHighlight=null;
 selectedMapDrag={id:selected,point:[x,y],rows:structuredClone(currentRows()),started:false};scene.setPointerCapture(e.pointerId);renderCounts();renderInspector();draw();e.preventDefault();
});
scene.addEventListener('pointermove',e=>{
 if(!selectedMapDrag)return;const [x,y]=scenePoint(e),dx=x-selectedMapDrag.point[0],dy=y-selectedMapDrag.point[1];
 if(!selectedMapDrag.started&&Math.abs(dx)+Math.abs(dy)<5)return;
 if(!selectedMapDrag.started){selectedMapRecord();selectedMapDrag.started=true;}
 selectedMapMove(selectedMapDrag.id,dx,dy,selectedMapDrag.rows);
});
scene.addEventListener('pointerup',()=>{if(!selectedMapDrag)return;selectedMapDragged=selectedMapDrag.started;selectedMapDrag=null;if(selectedMapDragged)selectedMapCommit();});
scene.addEventListener('pointercancel',()=>{if(!selectedMapDrag)return;const started=selectedMapDrag.started;selectedMapDrag=null;if(started)selectedMapCommit();});
const selectedMapClick=scene.onclick;
scene.onclick=e=>{if(selectedMapDragged){selectedMapDragged=false;return;}selectedMapClick(e);};
$('editLayout').onchange=()=>{$('canvasWrap').classList.toggle('edit-active',$('editLayout').checked);selectedMapStatus();};
for(const [id,dx,dy] of [['nudgeLeft',-8,0],['nudgeUp',0,-8],['nudgeDown',0,8],['nudgeRight',8,0]])$(id).onclick=()=>{if(!selected||!$('editLayout').checked)return;selectedMapRecord();selectedMapMove(selected,dx,dy);selectedMapCommit();};
$('undoMove').onclick=()=>{const undo=selectedMapUndo.get(selectedMapUndoKey());if(!undo?.length)return;currentLayout().instances=undo.pop();currentLayout().edited=JSON.stringify(currentRows())!==JSON.stringify(DATA.candidates.A1.profiles[densityProfile][scatterIndex].instances);selectedMapCommit();};
$('resetLayout').onclick=()=>{selectedMapRecord();selectedMapDrafts[densityProfile][scatterIndex]=structuredClone(DATA.candidates.A1.profiles[densityProfile][scatterIndex]);selectedMapCommit();};
$('exportLayout').onclick=()=>{
 const payload={schema:'selectedMap-layout.draft.v2',theme:level.name,canvas:[4096,4096],revision:DATA.meta.revision,backgroundSha256:DATA.meta.backgroundSha256,seed:currentLayout().seed,densityProfile,counts:level.counts,targets:level.targets,sizeStatus:DATA.meta.sizeStatus,assetHashes:Object.fromEntries(Object.entries(currentAssets()).map(([k,v])=>[k,v.sha256])),instances:currentRows(),checks:report};
 save(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),'selectedMap-'+densityProfile+'-seed-'+currentLayout().seed+'.json');
};
const selectedMapLevelChange=$('level').onchange;
$('level').onchange=()=>{if($('level').value==='2'){location.href='index.html';return;}selectedMapLevelChange();};
const selectedMapInit=init;
init=async function(){await selectedMapInit();const canyon=$('level').querySelector('option[value="2"]');if(canyon)canyon.textContent='大峡谷 · 已接入（切换）';};
