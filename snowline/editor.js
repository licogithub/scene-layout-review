'use strict';
// All changes operate on instances, never on the source art or original canyon data.
let snowlineDrafts=structuredClone(DATA.candidates.A1.profiles.balanced);
const snowlineUndo=new Map();
let snowlineDrag=null,snowlineDragged=false,snowlineRefresh=0;
const snowlineCacheKey=i=>'snowline-layout:'+DATA.meta.revision+':'+DATA.candidates.A1.profiles.balanced[i].seed;
function validSavedLayout(saved,i){
 const original=DATA.candidates.A1.profiles.balanced[i].instances;
 if(!Array.isArray(saved)||saved.length!==original.length)return false;
 return saved.every((r,n)=>r.instance_id===original[n].instance_id&&r.prototype_id===original[n].prototype_id&&r.parent_instance_id===original[n].parent_instance_id&&r.role===original[n].role&&Array.isArray(r.bbox)&&r.bbox.length===4&&r.bbox.every(Number.isFinite)&&r.bbox.every(Number.isInteger)&&r.bbox[0]>=0&&r.bbox[1]>=0&&r.bbox[2]<=4096&&r.bbox[3]<=4096&&r.bbox[2]-r.bbox[0]===DATA.assets[r.prototype_id].wh[0]&&r.bbox[3]-r.bbox[1]===DATA.assets[r.prototype_id].wh[1]&&Array.isArray(r.foot_anchor)&&r.foot_anchor.length===2&&r.foot_anchor.every(Number.isFinite)&&Number.isFinite(r.depth_y));
}
for(let i=0;i<snowlineDrafts.length;i++){
 try{const stored=JSON.parse(localStorage.getItem(snowlineCacheKey(i))||'null');if(validSavedLayout(stored,i)){snowlineDrafts[i].instances=stored;snowlineDrafts[i].edited=true;}}catch{}
}
currentLayouts=()=>snowlineDrafts;
currentLayout=()=>snowlineDrafts[scatterIndex];
const snowlineAnalyze=analyze;
analyze=function(rows){const result=snowlineAnalyze(rows);result.data.schema='snowline-layout-review.draft.v1';result.data.geometryValidation={status:'visual_trial_pending_review',railCars:rows.filter(r=>r.prototype_id==='vehicle-01').length,roadHaulers:rows.filter(r=>r.prototype_id==='vehicle-02').length};result.data.artStatus='approved_v7_style_scene_scale_draft';result.data.layoutSha256=currentLayout().edited?null:currentLayout().sha256;result.data.manuallyEdited=!!currentLayout().edited;return result;};
function snowlineStatus(){
 $('editStatus').textContent=currentLayout().edited?'已微调 · 自动保存到当前浏览器':'初排位置';
 $('undoMove').disabled=!(snowlineUndo.get(scatterIndex)?.length);
 const enabled=!!selected&&$('editLayout').checked&&!!report;
 for(const id of ['nudgeLeft','nudgeUp','nudgeDown','nudgeRight'])$(id).disabled=!enabled;
}
const snowlineInspector=renderInspector;
renderInspector=function(){snowlineInspector();snowlineStatus();};
renderValidation=function(){
 if(!report){$('validation').innerHTML=line('精确核数','正在加载');$('occlusionList').textContent='暂无可检查的场景。';return;}
 $('validation').innerHTML=line('逐种数量',report.quantityMatched?'全部一致':'存在差异',report.quantityMatched?'good':'bad')+line('实际绘制 / 要求',report.renderedTotal+' / '+report.expectedTotal)+line('有前景可见',report.visibleTotal+' / '+report.renderedTotal,report.visibleTotal===171?'good':'bad')+line('目标子集',report.actualTargetTotal+' / '+report.expectedTargetTotal)+line('建筑 + 道具组合',report.declaredStackCount+' / 15组')+line('额外像素遮挡',report.unexpectedOverlapPairs.length+'对',report.unexpectedOverlapPairs.length?'warn':'good')+line('画面外物件',report.outOfBounds.length+'个',report.outOfBounds.length?'bad':'good')+line('矿车 / 履带车','15 / 12')+line('落地与路线','初排待细查','warn');
 const list=$('occlusionList');list.replaceChildren();
 for(const r of report.instances.filter(r=>r.visibility<1).sort((a,b)=>a.visibility-b.visibility)){
  const b=document.createElement('button');b.className='occlusion-row';b.textContent=instanceLabel(r)+' · '+r.name;const span=document.createElement('span');span.textContent='保留 '+(r.visibility*100).toFixed(1)+'%';b.append(span);b.onclick=()=>selectInstance(r.instance_id,true);list.append(b);
 }
 if(!list.children.length)list.textContent='没有检测到前景像素覆盖。';
 snowlineStatus();
};
function snowlinePaintBase(){
 drawOrder=sortedInstances(currentRows());baseCtx.clearRect(0,0,4096,4096);baseCtx.drawImage(backgrounds[candidate],0,0,4096,4096);for(const r of drawOrder)paint(baseCtx,r);draw();
}
function snowlineRecord(){
 const undo=snowlineUndo.get(scatterIndex)||[];undo.push(structuredClone(currentRows()));if(undo.length>30)undo.shift();snowlineUndo.set(scatterIndex,undo);
}
function snowlineCommit(){
 for(const key of Object.keys(analysisCache))delete analysisCache[key];
 const a=analyze(currentRows());report=a.data;owner=a.grid;snowlinePaintBase();renderCounts();renderValidation();renderInspector();
 try{localStorage.setItem(snowlineCacheKey(scatterIndex),JSON.stringify(currentRows()));}catch{$('editStatus').textContent='浏览器未允许自动保存，请导出布局JSON';}
}
function snowlineMove(id,dx,dy,startRows=null){
 const rows=currentRows(),start=startRows||structuredClone(rows),group=[id,...rows.filter(r=>r.parent_instance_id===id).map(r=>r.instance_id)];
 const moving=start.filter(r=>group.includes(r.instance_id));if(!moving.length)return;
 dx=Math.round(Math.max(-Math.min(...moving.map(r=>r.bbox[0])),Math.min(4096-Math.max(...moving.map(r=>r.bbox[2])),dx)));
 dy=Math.round(Math.max(-Math.min(...moving.map(r=>r.bbox[1])),Math.min(4096-Math.max(...moving.map(r=>r.bbox[3])),dy)));
 for(const origin of moving){const r=rows.find(r=>r.instance_id===origin.instance_id);r.bbox=origin.bbox.map((v,k)=>v+(k%2?dy:dx));r.foot_anchor=[origin.foot_anchor[0]+dx,origin.foot_anchor[1]+dy];r.depth_y=origin.depth_y+dy;r.manually_moved=true;}
 currentLayout().edited=true;snowlinePaintBase();snowlineStatus();
}
function scenePoint(e){const rect=scene.getBoundingClientRect();return [Math.floor((e.clientX-rect.left)*4096/rect.width),Math.floor((e.clientY-rect.top)*4096/rect.height)];}
scene.addEventListener('pointerdown',e=>{
 if(!$('editLayout').checked||!report||!$('showObjects').checked)return;
 const [x,y]=scenePoint(e),number=x>=0&&x<4096&&y>=0&&y<4096?owner[y*4096+x]:0;
 if(!number)return;selected=currentRows()[number-1].instance_id;typeHighlight=null;
 snowlineDrag={id:selected,point:[x,y],rows:structuredClone(currentRows()),started:false};scene.setPointerCapture(e.pointerId);renderCounts();renderInspector();draw();e.preventDefault();
});
scene.addEventListener('pointermove',e=>{
 if(!snowlineDrag)return;const [x,y]=scenePoint(e),dx=x-snowlineDrag.point[0],dy=y-snowlineDrag.point[1];
 if(!snowlineDrag.started&&Math.abs(dx)+Math.abs(dy)<5)return;
 if(!snowlineDrag.started){snowlineRecord();snowlineDrag.started=true;}
 snowlineMove(snowlineDrag.id,dx,dy,snowlineDrag.rows);
});
scene.addEventListener('pointerup',()=>{if(!snowlineDrag)return;snowlineDragged=snowlineDrag.started;snowlineDrag=null;if(snowlineDragged)snowlineCommit();});
scene.addEventListener('pointercancel',()=>{if(!snowlineDrag)return;const started=snowlineDrag.started;snowlineDrag=null;if(started)snowlineCommit();});
const snowlineClick=scene.onclick;
scene.onclick=e=>{if(snowlineDragged){snowlineDragged=false;return;}snowlineClick(e);};
$('editLayout').onchange=()=>{$('canvasWrap').classList.toggle('edit-active',$('editLayout').checked);snowlineStatus();};
for(const [id,dx,dy] of [['nudgeLeft',-8,0],['nudgeUp',0,-8],['nudgeDown',0,8],['nudgeRight',8,0]])$(id).onclick=()=>{if(!selected||!$('editLayout').checked)return;snowlineRecord();snowlineMove(selected,dx,dy);snowlineCommit();};
$('undoMove').onclick=()=>{const undo=snowlineUndo.get(scatterIndex);if(!undo?.length)return;currentLayout().instances=undo.pop();currentLayout().edited=true;snowlineCommit();};
$('resetLayout').onclick=()=>{snowlineRecord();snowlineDrafts[scatterIndex]=structuredClone(DATA.candidates.A1.profiles.balanced[scatterIndex]);snowlineCommit();};
$('exportLayout').onclick=()=>{
 const payload={schema:'snowline-layout.draft.v1',theme:'雪线矿镇',canvas:[4096,4096],revision:DATA.meta.revision,backgroundSha256:DATA.meta.backgroundSha256,seed:currentLayout().seed,counts:level.counts,targets:level.targets,sizeStatus:DATA.meta.sizeStatus,assetHashes:Object.fromEntries(Object.entries(DATA.assets).map(([k,v])=>[k,v.sha256])),instances:currentRows(),checks:report};
 save(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),'snowline-layout-seed-'+currentLayout().seed+'.json');
};
const snowlineLevelChange=$('level').onchange;
$('level').onchange=()=>{if($('level').value==='2'){location.href='index.html';return;}snowlineLevelChange();};
const snowlineInit=init;
init=async function(){await snowlineInit();const canyon=$('level').querySelector('option[value="2"]');if(canyon)canyon.textContent='大峡谷 · 已接入（切换）';};
