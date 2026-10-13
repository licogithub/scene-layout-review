'use strict';
// All changes operate on instances, never on the source art or original canyon data.
let windmillDrafts=structuredClone(DATA.candidates.A1.profiles);
const windmillUndo=new Map();
let windmillDrag=null,windmillDragged=false,windmillRefresh=0;
const windmillCacheKey=(i,p=densityProfile)=>'windmill-layout:'+DATA.meta.revision+':'+p+':'+DATA.candidates.A1.profiles[p][i].seed;
const windmillUndoKey=()=>densityProfile+':'+scatterIndex;
function validSavedLayout(saved,i,p){
 const original=DATA.candidates.A1.profiles[p][i].instances;
 if(!Array.isArray(saved)||saved.length!==original.length)return false;
 return saved.every((r,n)=>r.instance_id===original[n].instance_id&&r.prototype_id===original[n].prototype_id&&r.parent_instance_id===original[n].parent_instance_id&&r.role===original[n].role&&Array.isArray(r.bbox)&&r.bbox.length===4&&r.bbox.every(Number.isFinite)&&r.bbox.every(Number.isInteger)&&r.bbox[0]>=0&&r.bbox[1]>=0&&r.bbox[2]<=4096&&r.bbox[3]<=4096&&r.bbox[2]-r.bbox[0]===DATA.assetSets[p][r.prototype_id].wh[0]&&r.bbox[3]-r.bbox[1]===DATA.assetSets[p][r.prototype_id].wh[1]&&Array.isArray(r.foot_anchor)&&r.foot_anchor.length===2&&r.foot_anchor.every(Number.isFinite)&&Number.isFinite(r.depth_y));
}
for(const [p,layouts] of Object.entries(windmillDrafts))for(let i=0;i<layouts.length;i++){
 try{const stored=JSON.parse(localStorage.getItem(windmillCacheKey(i,p))||'null'),rows=Array.isArray(stored)?stored:stored?.instances;if(validSavedLayout(rows,i,p)){windmillDrafts[p][i].instances=rows;windmillDrafts[p][i].edited=stored?.edited!==false;}}catch{}
}
currentLayouts=()=>windmillDrafts[densityProfile];
currentLayout=()=>windmillDrafts[densityProfile][scatterIndex];
const windmillAnalyze=analyze;
analyze=function(rows){const result=windmillAnalyze(rows);result.data.schema='windmill-layout-review.draft.v1';result.data.geometryValidation={status:'visual_trial_pending_review',farmWagons:rows.filter(r=>r.prototype_id==='vehicle-01').length,tractors:rows.filter(r=>r.prototype_id==='vehicle-02').length};result.data.artStatus='approved_windmill_style_scene_scale_draft';result.data.layoutSha256=currentLayout().edited?null:currentLayout().sha256;result.data.manuallyEdited=!!currentLayout().edited;return result;};
function windmillStatus(){
 $('editStatus').textContent=currentLayout().edited?'已微调 · 自动保存到当前浏览器':'初排位置';
 $('undoMove').disabled=!(windmillUndo.get(windmillUndoKey())?.length);
 const enabled=!!selected&&$('editLayout').checked&&!!report;
 for(const id of ['nudgeLeft','nudgeUp','nudgeDown','nudgeRight'])$(id).disabled=!enabled;
}
const windmillInspector=renderInspector;
renderInspector=function(){windmillInspector();windmillStatus();};
renderValidation=function(){
 if(!report){$('validation').innerHTML=line('精确核数','正在加载');$('occlusionList').textContent='暂无可检查的场景。';return;}
 $('validation').innerHTML=line('逐种数量',report.quantityMatched?'全部一致':'存在差异',report.quantityMatched?'good':'bad')+line('实际绘制 / 要求',report.renderedTotal+' / '+report.expectedTotal)+line('有前景可见',report.visibleTotal+' / '+report.renderedTotal,report.visibleTotal===168?'good':'bad')+line('目标子集',report.actualTargetTotal+' / '+report.expectedTargetTotal)+line('建筑 + 道具组合',report.declaredStackCount+' / 0组')+line('额外像素遮挡',report.unexpectedOverlapPairs.length+'对',report.unexpectedOverlapPairs.length?'warn':'good')+line('画面外物件',report.outOfBounds.length+'个',report.outOfBounds.length?'bad':'good')+line('原向 / 镜向',report.facingCounts.original+' / '+report.facingCounts.mirrored)+line('预留空地',(currentLayout().checks.clearing_count||0)+'块 · '+((currentLayout().checks.reserved_empty_ground_ratio||0)*100).toFixed(1)+'%')+line('农用板车 / 拖拉机','3 / 6')+line('落地与路线','初排待细查','warn');
 const list=$('occlusionList');list.replaceChildren();
 for(const r of report.instances.filter(r=>r.visibility<1).sort((a,b)=>a.visibility-b.visibility)){
  const b=document.createElement('button');b.className='occlusion-row';b.textContent=instanceLabel(r)+' · '+r.name;const span=document.createElement('span');span.textContent='保留 '+(r.visibility*100).toFixed(1)+'%';b.append(span);b.onclick=()=>selectInstance(r.instance_id,true);list.append(b);
 }
 if(!list.children.length)list.textContent='没有检测到前景像素覆盖。';
 windmillStatus();
};
function windmillPaintBase(){
 drawOrder=sortedInstances(currentRows());baseCtx.clearRect(0,0,4096,4096);baseCtx.drawImage(backgrounds[candidate],0,0,4096,4096);for(const r of drawOrder)paint(baseCtx,r);draw();
}
function windmillRecord(){
 const undo=windmillUndo.get(windmillUndoKey())||[];undo.push(structuredClone(currentRows()));if(undo.length>30)undo.shift();windmillUndo.set(windmillUndoKey(),undo);
}
function windmillCommit(){
 for(const key of Object.keys(analysisCache))delete analysisCache[key];
 const a=analyze(currentRows());report=a.data;owner=a.grid;windmillPaintBase();renderCounts();renderValidation();renderInspector();
 try{localStorage.setItem(windmillCacheKey(scatterIndex),JSON.stringify({instances:currentRows(),edited:!!currentLayout().edited}));}catch{$('editStatus').textContent='浏览器未允许自动保存，请导出布局JSON';}
}
function windmillMove(id,dx,dy,startRows=null){
 const rows=currentRows(),start=startRows||structuredClone(rows),group=[id,...rows.filter(r=>r.parent_instance_id===id).map(r=>r.instance_id)];
 const moving=start.filter(r=>group.includes(r.instance_id));if(!moving.length)return;
 dx=Math.round(Math.max(-Math.min(...moving.map(r=>r.bbox[0])),Math.min(4096-Math.max(...moving.map(r=>r.bbox[2])),dx)));
 dy=Math.round(Math.max(-Math.min(...moving.map(r=>r.bbox[1])),Math.min(4096-Math.max(...moving.map(r=>r.bbox[3])),dy)));
 for(const origin of moving){const r=rows.find(r=>r.instance_id===origin.instance_id);r.bbox=origin.bbox.map((v,k)=>v+(k%2?dy:dx));r.foot_anchor=[origin.foot_anchor[0]+dx,origin.foot_anchor[1]+dy];r.depth_y=origin.depth_y+dy;r.manually_moved=true;}
 currentLayout().edited=true;windmillPaintBase();windmillStatus();
}
function scenePoint(e){const rect=scene.getBoundingClientRect();return [Math.floor((e.clientX-rect.left)*4096/rect.width),Math.floor((e.clientY-rect.top)*4096/rect.height)];}
scene.addEventListener('pointerdown',e=>{
 if(!$('editLayout').checked||!report||!$('showObjects').checked)return;
 const [x,y]=scenePoint(e),number=x>=0&&x<4096&&y>=0&&y<4096?owner[y*4096+x]:0;
 if(!number)return;selected=currentRows()[number-1].instance_id;typeHighlight=null;
 windmillDrag={id:selected,point:[x,y],rows:structuredClone(currentRows()),started:false};scene.setPointerCapture(e.pointerId);renderCounts();renderInspector();draw();e.preventDefault();
});
scene.addEventListener('pointermove',e=>{
 if(!windmillDrag)return;const [x,y]=scenePoint(e),dx=x-windmillDrag.point[0],dy=y-windmillDrag.point[1];
 if(!windmillDrag.started&&Math.abs(dx)+Math.abs(dy)<5)return;
 if(!windmillDrag.started){windmillRecord();windmillDrag.started=true;}
 windmillMove(windmillDrag.id,dx,dy,windmillDrag.rows);
});
scene.addEventListener('pointerup',()=>{if(!windmillDrag)return;windmillDragged=windmillDrag.started;windmillDrag=null;if(windmillDragged)windmillCommit();});
scene.addEventListener('pointercancel',()=>{if(!windmillDrag)return;const started=windmillDrag.started;windmillDrag=null;if(started)windmillCommit();});
const windmillClick=scene.onclick;
scene.onclick=e=>{if(windmillDragged){windmillDragged=false;return;}windmillClick(e);};
$('editLayout').onchange=()=>{$('canvasWrap').classList.toggle('edit-active',$('editLayout').checked);windmillStatus();};
for(const [id,dx,dy] of [['nudgeLeft',-8,0],['nudgeUp',0,-8],['nudgeDown',0,8],['nudgeRight',8,0]])$(id).onclick=()=>{if(!selected||!$('editLayout').checked)return;windmillRecord();windmillMove(selected,dx,dy);windmillCommit();};
$('undoMove').onclick=()=>{const undo=windmillUndo.get(windmillUndoKey());if(!undo?.length)return;currentLayout().instances=undo.pop();currentLayout().edited=JSON.stringify(currentRows())!==JSON.stringify(DATA.candidates.A1.profiles[densityProfile][scatterIndex].instances);windmillCommit();};
$('resetLayout').onclick=()=>{windmillRecord();windmillDrafts[densityProfile][scatterIndex]=structuredClone(DATA.candidates.A1.profiles[densityProfile][scatterIndex]);windmillCommit();};
$('exportLayout').onclick=()=>{
 const payload={schema:'windmill-layout.draft.v2',theme:'风车麦田',canvas:[4096,4096],revision:DATA.meta.revision,backgroundSha256:DATA.meta.backgroundSha256,seed:currentLayout().seed,densityProfile,counts:level.counts,targets:level.targets,sizeStatus:DATA.meta.sizeStatus,assetHashes:Object.fromEntries(Object.entries(currentAssets()).map(([k,v])=>[k,v.sha256])),instances:currentRows(),checks:report};
 save(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),'windmill-'+densityProfile+'-seed-'+currentLayout().seed+'.json');
};
const windmillLevelChange=$('level').onchange;
$('level').onchange=()=>{if($('level').value==='2'){location.href='index.html';return;}windmillLevelChange();};
const windmillInit=init;
init=async function(){await windmillInit();const canyon=$('level').querySelector('option[value="2"]');if(canyon)canyon.textContent='大峡谷 · 已接入（切换）';};
