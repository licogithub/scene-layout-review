
'use strict';
const $=id=>document.getElementById(id);
const catNames={building:'建筑',facility:'道具',vehicle:'载具',character:'角色'};
const shortNames={building:'B',facility:'P',vehicle:'V',character:'C'};
const category=id=>id.split('-')[0];
const byId=Object.fromEntries(Object.entries(DATA.assets));
const scene=$('scene'),ctx=scene.getContext('2d'),view=$('viewport');
const base=document.createElement('canvas');base.width=base.height=4096;const baseCtx=base.getContext('2d');
let level=DATA.levels.find(l=>l.available),candidate='A',selected=null,typeHighlight=null,zoom=1,drawOrder=[],owner=null,report=null;
let generation=0;
const masks={},images={},backgrounds={},analysisCache={};
function img(src){return new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('图片资源无法解码'));i.src=src;});}
function loading(value,text){$('loading').hidden=!value;if(text)$('loadingText').textContent=text;}
function instanceLabel(r){return shortNames[category(r.prototype_id)]+r.prototype_id.split('-')[1]+'-'+r.instance_id.split('-').at(-1);}
function assetName(id){return byId[id]?.name||catNames[category(id)]+Number(id.split('-')[1]);}
function sortedInstances(rows){return [...rows].sort((a,b)=>a.layer-b.layer||a.foot_anchor[1]-b.foot_anchor[1]||a.instance_id.localeCompare(b.instance_id));}
function analyze(rows){
 const ids=new Map(rows.map((r,i)=>[r.instance_id,i+1]));
 const indexById=Object.fromEntries(rows.map((r,i)=>[r.instance_id,i]));
 const grid=new Uint16Array(4096*4096),areas=new Uint32Array(rows.length+1),visible=new Uint32Array(rows.length+1);
 const rendered={},targetCounts={},outOfBounds=[],overlapPairs=new Map();
 for(const r of sortedInstances(rows)){
  const number=ids.get(r.instance_id),m=masks[r.prototype_id];const [x,y,x1,y1]=r.bbox;
  if(x<0||y<0||x1>4096||y1>4096||x1-x!==m.w||y1-y!==m.h){outOfBounds.push(r.instance_id);continue;}
  rendered[r.prototype_id]=(rendered[r.prototype_id]||0)+1;if(r.role==='target')targetCounts[r.prototype_id]=(targetCounts[r.prototype_id]||0)+1;
  for(let j=0;j<m.h;j++)for(let k=0;k<m.w;k++)if(m.alpha[j*m.w+k]>16){
   const at=(y+j)*4096+x+k,prev=grid[at];areas[number]++;
   if(prev){const key=Math.min(prev,number)+':'+Math.max(prev,number);overlapPairs.set(key,(overlapPairs.get(key)||0)+1);}
   grid[at]=number;
  }
 }
 for(let i=0;i<grid.length;i++)if(grid[i])visible[grid[i]]++;
 const instances=rows.map((r,i)=>({...r,name:assetName(r.prototype_id),foregroundPixels:areas[i+1],visiblePixels:visible[i+1],visibility:areas[i+1]?visible[i+1]/areas[i+1]:0}));
 const pairs=[...overlapPairs].map(([key,pixels])=>{const [a,b]=key.split(':').map(Number);const first=rows[a-1],second=rows[b-1];return {first:first.instance_id,second:second.instance_id,pixels,declared:first.parent_instance_id===second.instance_id||second.parent_instance_id===first.instance_id};});
 const perType=Object.entries(level.counts).map(([id,required])=>({id,name:assetName(id),required,rendered:rendered[id]||0,visible:instances.filter(r=>r.prototype_id===id&&r.visiblePixels>0).length,match:required===(rendered[id]||0)}));
 const targetMatch=Object.keys({...level.targets,...targetCounts}).every(k=>(level.targets[k]||0)===(targetCounts[k]||0));
 const unexpected=pairs.filter(p=>!p.declared),stackCount=rows.filter(r=>r.parent_instance_id).length;
 return {grid,indexById,data:{schema:'local-scene-quantity-preview.v1',candidate,level:level.name,canvas:[4096,4096],expectedTotal:level.total,renderedTotal:Object.values(rendered).reduce((a,b)=>a+b,0),uniqueIds:ids.size,visibleTotal:instances.filter(r=>r.visiblePixels>0).length,expectedTargetTotal:level.targetTotal,actualTargetTotal:Object.values(targetCounts).reduce((a,b)=>a+b,0),targetMatch,declaredStackCount:stackCount,expectedStackCount:level.stacks,unexpectedOverlapPairs:unexpected,outOfBounds,quantityMatched:perType.every(p=>p.match)&&ids.size===level.total&&targetMatch&&stackCount===level.stacks&&!outOfBounds.length,perType,instances,overlapPairs:pairs,visibilityMethod:'Foreground alpha > 16. Frontmost sprite owns each foreground pixel. A conservative pixel ownership measure, not perceptual recognizability.',artStatus:'experimental_pending_review',sourceWorkbookSha256:DATA.audit.sourceWorkbookSha256,layoutSha256:DATA.audit.candidates[candidate].layoutSha256}};
}
function renderCounts(){
 const container=$('counts');container.replaceChildren();
 for(const cat of level.categories){
  const head=document.createElement('div');head.className='group-head';head.innerHTML='<span class="dot '+cat.prefix+'"></span>'+cat.name+' <span class="muted" style="font-size:10px;font-weight:400">'+cat.kinds+'种 · '+cat.total+'个</span>';container.append(head);
  for(const [id,n]of Object.entries(level.counts).filter(([id])=>category(id)===cat.prefix)){
   const row=document.createElement('button');row.className='item-row'+(typeHighlight===id?' active':'');row.dataset.type=id;
   const req=document.createElement('span');req.className='item-name';req.textContent=level.available?assetName(id):cat.name+Number(id.split('-')[1]);row.append(req);
   const need=document.createElement('span');need.textContent=n;row.append(need);
   const actual=document.createElement('span');const proof=report?.perType.find(p=>p.id===id);actual.textContent=proof?proof.rendered:'—';actual.className=proof?(proof.match?'good':'bad'):'muted';row.append(actual);
   row.onclick=()=>{if(!level.available)return;typeHighlight=typeHighlight===id?null:id;selected=null;renderCounts();draw();renderInspector();};container.append(row);
  }
 }
}
function line(label,value,style=''){return '<div class="status-block"><span>'+label+'</span><b class="'+style+'">'+value+'</b></div>';}
function renderValidation(){
 if(!report){$('validation').innerHTML=line('精确核数','等待资源','warn')+line('要求总数',level.total)+line('声明叠放',level.stacks+'套');$('occlusionList').textContent='暂无可检查的场景。';return;}
 $('validation').innerHTML=line('逐种数量',report.quantityMatched?'全部一致':'存在差异',report.quantityMatched?'good':'bad')+line('实际绘制 / 要求',report.renderedTotal+' / '+report.expectedTotal)+line('有前景可见',report.visibleTotal+' / '+report.renderedTotal,report.visibleTotal===report.renderedTotal?'good':'bad')+line('目标子集',report.actualTargetTotal+' / '+report.expectedTargetTotal)+line('声明叠放',report.declaredStackCount+' / '+report.expectedStackCount+'套')+line('额外遮挡',report.unexpectedOverlapPairs.length+'对',report.unexpectedOverlapPairs.length?'bad':'good');
 const list=$('occlusionList');list.replaceChildren();
 const occluded=report.instances.filter(r=>r.visibility<1).sort((a,b)=>a.visibility-b.visibility);
 if(!occluded.length){list.textContent='没有检测到前景像素覆盖。';return;}
 for(const r of occluded){const b=document.createElement('button');b.className='occlusion-row';b.innerHTML=instanceLabel(r)+' · '+r.name+'<span>保留 '+(r.visibility*100).toFixed(1)+'%</span>';b.onclick=()=>selectInstance(r.instance_id,true);list.append(b);}
}
function renderInspector(){
 const r=report?.instances.find(r=>r.instance_id===selected);const box=$('inspector');box.replaceChildren();
 if(!r){const p=document.createElement('div');p.className='inspector-placeholder';p.textContent=typeHighlight?'已高亮 '+assetName(typeHighlight)+' 的全部实例。点击地图查看其中一个。':'点击地图上的物件，查看编号、目标身份、位置和遮挡情况。';box.append(p);return;}
 const card=document.createElement('div');card.className='asset-card';const i=document.createElement('img');i.src=byId[r.prototype_id].src;i.alt=r.name;card.append(i);const name=document.createElement('div');name.innerHTML='<div class="asset-name">'+r.name+'</div><div class="asset-id">'+r.instance_id+'</div>';card.append(name);box.append(card);
 const values=[['实例身份',r.role==='target'?'目标（包含在总数内）':'非目标物件'],['坐标（左上角）',r.bbox[0]+', '+r.bbox[1]],['绘制尺寸',(r.bbox[2]-r.bbox[0])+' × '+(r.bbox[3]-r.bbox[1])+' px'],['前景保留率',(r.visibility*100).toFixed(2)+'%'],['叠放关系',r.parent_instance_id?'位于 '+instanceLabel(report.instances.find(t=>t.instance_id===r.parent_instance_id))+' 上':report.instances.some(t=>t.parent_instance_id===r.instance_id)?'承载一个叠放物件':'无']];
 for(const [k,v]of values){const d=document.createElement('div');d.className='detail-line';const a=document.createElement('span');a.className='muted';a.textContent=k;const b=document.createElement('span');b.textContent=v;d.append(a,b);box.append(d);}
 const overlapping=report.overlapPairs.filter(p=>p.first===r.instance_id||p.second===r.instance_id);
 for(const p of overlapping){const other=p.first===r.instance_id?p.second:p.first;const b=document.createElement('button');b.className='small-link';b.style.display='block';b.textContent='查看'+(p.declared?'叠放关联':'额外遮挡')+'：'+instanceLabel(report.instances.find(i=>i.instance_id===other));b.onclick=()=>selectInstance(other);box.append(b);}
}
function highlightRect(r,color,width=9,dash=[]){const [x,y,x1,y1]=r.bbox;ctx.save();ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.strokeRect(x-5,y-5,x1-x+10,y1-y+10);ctx.restore();}
function draw(){
 if(!report)return;ctx.clearRect(0,0,4096,4096);
 if($('showObjects').checked)ctx.drawImage(base,0,0);else ctx.drawImage(backgrounds[candidate],0,0);
 if($('showObjects').checked){
  if(typeHighlight){ctx.fillStyle='#fbfaf6a8';ctx.fillRect(0,0,4096,4096);for(const r of drawOrder.filter(r=>r.prototype_id===typeHighlight)){ctx.drawImage(images[r.prototype_id],r.bbox[0],r.bbox[1]);highlightRect(r,'#bb592f',8);}}
  if($('showTargets').checked)for(const r of drawOrder.filter(r=>r.role==='target'))highlightRect(r,'#327b5c',8,[16,9]);
  if($('showOverlap').checked)for(const p of report.overlapPairs){for(const id of [p.first,p.second])highlightRect(report.instances.find(r=>r.instance_id===id),p.declared?'#d19b27':'#cc3d3d',8,[12,8]);}
  if($('showIds').checked){ctx.font='600 28px "Segoe UI",sans-serif';ctx.textBaseline='top';for(const r of drawOrder){const label=instanceLabel(r),w=ctx.measureText(label).width;ctx.fillStyle='#fff9e9ec';ctx.fillRect(r.bbox[0],r.bbox[1]-24,w+12,36);ctx.fillStyle='#3e3932';ctx.fillText(label,r.bbox[0]+6,r.bbox[1]-20);}}
  if(selected){const r=report.instances.find(i=>i.instance_id===selected);if(r)highlightRect(r,'#fff',15);if(r)highlightRect(r,'#bb592f',8);}
 }
 $('mapStatus').textContent=report.renderedTotal+' 个实例 · '+level.kinds+' 种素材 · '+(typeHighlight?'高亮 '+assetName(typeHighlight):$('showObjects').checked?'物件层已显示':'仅显示干净底图');
 syncShareState();
}
function updateSize(){if(!level.available)return;const fit=Math.max(180,Math.min(view.clientWidth-24,view.clientHeight-24));const size=Math.round(fit*zoom);scene.style.width=size+'px';scene.style.height=size+'px';$('zoomValue').textContent=Math.round(zoom*100)+'%';}
function selectInstance(id,focus=false){selected=id;typeHighlight=null;renderCounts();draw();renderInspector();if(focus){zoom=Math.max(zoom,2);updateSize();requestAnimationFrame(()=>{const r=report.instances.find(r=>r.instance_id===id);const scale=parseFloat(scene.style.width)/4096;view.scrollLeft=(r.bbox[0]+r.bbox[2])/2*scale-view.clientWidth/2;view.scrollTop=(r.bbox[1]+r.bbox[3])/2*scale-view.clientHeight/2;});}}
async function switchScene(state=null){
 const revision=++generation;selected=null;typeHighlight=null;zoom=1;report=null;owner=null;renderCounts();renderInspector();renderValidation();
 $('total').textContent=level.total;$('kinds').textContent=level.kinds;$('targets').textContent=level.targetTotal;$('levelInfo').textContent='档位 '+level.tier+' · 时长 '+level.duration+' · 表格第 '+level.sourceRow+' 行';
 $('canvasWrap').hidden=!level.available;$('empty').hidden=level.available;$('candidateTabs').querySelectorAll('button').forEach(b=>{b.disabled=!level.available;b.classList.toggle('active',b.dataset.candidate===candidate);});
 $('exportImage').disabled=$('exportReport').disabled=!level.available;
 document.querySelectorAll('.view-toggles input,.zoom-controls button').forEach(b=>b.disabled=!level.available);
 if(!level.available){$('mapTitle').textContent=level.name;$('mapStatus').textContent='已读取数量要求 · 尚未接入场景资源';$('emptyText').textContent=level.name+'需要 '+level.kinds+' 种素材、'+level.total+' 个实例。';loading(false);syncShareState();return;}
 loading(true,'正在解码候选 '+candidate+' 并计算前景遮挡…');
 try{
  if(!backgrounds[candidate])backgrounds[candidate]=await img(DATA.candidates[candidate].background);if(revision!==generation)return;
  await new Promise(r=>setTimeout(r,20));if(revision!==generation)return;
  if(!analysisCache[candidate])analysisCache[candidate]=analyze(DATA.candidates[candidate].instances);
  const analysis=analysisCache[candidate];report=analysis.data;owner=analysis.grid;drawOrder=sortedInstances(DATA.candidates[candidate].instances);
  baseCtx.clearRect(0,0,4096,4096);baseCtx.drawImage(backgrounds[candidate],0,0);
  for(const r of drawOrder)baseCtx.drawImage(images[r.prototype_id],r.bbox[0],r.bbox[1]);
  $('mapTitle').textContent=level.name+' · '+candidate+' '+DATA.candidates[candidate].name;
  renderCounts();renderValidation();draw();updateSize();if(state)await restoreViewState(state);loading(false);syncShareState();
 }catch(e){loading(false);$('mapStatus').textContent='加载失败：'+e.message;$('validation').textContent='资源未加载完成，不能声明数量通过。';$('exportImage').disabled=$('exportReport').disabled=true;}
}
function save(blob,name){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),10000);}
$('exportReport').onclick=()=>{if(report)save(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),'canyon-'+candidate+'-count-report.json');};
$('exportImage').onclick=()=>{if(report)base.toBlob(b=>{if(b)save(b,'canyon-'+candidate+'-4096.png');},'image/png');};
$('level').onchange=()=>{level=DATA.levels.find(l=>l.id===Number($('level').value));switchScene();};
$('candidateTabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{candidate=b.dataset.candidate;switchScene();});
for(const id of ['showObjects','showIds','showTargets','showOverlap'])$(id).onchange=draw;
$('clearType').onclick=()=>{typeHighlight=null;selected=null;renderCounts();renderInspector();draw();};
$('zoomIn').onclick=()=>{zoom=Math.min(8,zoom*1.5);updateSize();};$('zoomOut').onclick=()=>{zoom=Math.max(.5,zoom/1.5);updateSize();};$('fit').onclick=()=>{zoom=1;updateSize();view.scrollTop=view.scrollLeft=0;};
scene.onclick=e=>{if(!owner||!$('showObjects').checked)return;const rect=scene.getBoundingClientRect();const x=Math.floor((e.clientX-rect.left)*4096/rect.width),y=Math.floor((e.clientY-rect.top)*4096/rect.height);const number=x>=0&&x<4096&&y>=0&&y<4096?owner[y*4096+x]:0;selected=number?DATA.candidates[candidate].instances[number-1].instance_id:null;typeHighlight=null;renderCounts();renderInspector();draw();};
new ResizeObserver(updateSize).observe(view);
async function init(){
 for(const l of DATA.levels){const o=document.createElement('option');o.value=l.id;o.textContent=l.name+(l.available?' · 已接入':' · 待接入');o.selected=l.id===level.id;$('level').append(o);}
 try{
  await Promise.all(Object.entries(DATA.assets).map(async([id,a])=>{const i=await img(a.src);if(i.naturalWidth!==a.wh[0]||i.naturalHeight!==a.wh[1])throw new Error(id+' 尺寸与记录不符');images[id]=i;const c=document.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;const t=c.getContext('2d',{willReadFrequently:true});t.drawImage(i,0,0);const rgba=t.getImageData(0,0,c.width,c.height).data,alpha=new Uint8Array(c.width*c.height);for(let n=0;n<alpha.length;n++)alpha[n]=rgba[n*4+3];masks[id]={w:c.width,h:c.height,alpha};}));
  await switchScene(initialViewState);
 }catch(e){loading(false);$('mapStatus').textContent='素材解码失败：'+e.message;$('validation').textContent='无法核数';}
}
