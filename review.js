'use strict';
// Shared by the published viewer; the original preview application stays unchanged.
const reviewFlags = [...document.querySelectorAll('.view-toggles input[id]')].map(e=>e.id);
let reviewRestoring = true, reviewGeneration = 0, reviewScrollTimer, reviewToastTimer;
const reviewDefaultDensity = typeof densityProfile === 'undefined' ? 'original' : densityProfile;
function reviewLayouts(id, density) {
 const c = DATA.candidates[id];
 return c.profiles?.[density] || c.layouts || [{instances:c.instances}];
}
function parseViewState(hash=location.hash) {
 const p = new URLSearchParams(hash.replace(/^#/,''));
 const chosenLevel = DATA.levels.find(l=>String(l.id)===p.get('level')) || DATA.levels.find(l=>l.available);
 let chosen = p.get('candidate');
 if (!Object.hasOwn(DATA.candidates,chosen)) chosen = Object.hasOwn(DATA.candidates,chosen+'1') ? chosen+'1' : Object.keys(DATA.candidates)[0];
 const profile = Object.hasOwn(DATA.densityProfiles || {original:{}},p.get('density')) ? p.get('density') : reviewDefaultDensity;
 const num=(key,fallback,min,max)=>{const value=p.get(key);if(value===null||value.trim()==='')return fallback;const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;};
 const scatter = Math.floor(num('scatter',1,1,reviewLayouts(chosen,profile).length))-1;
 const rows = chosenLevel.available ? reviewLayouts(chosen,profile)[scatter].instances : [];
 return {level:chosenLevel.id,candidate:chosen,density:profile,scatter,
  instance:rows.some(r=>r.instance_id===p.get('instance'))?p.get('instance'):null,
  type:Object.hasOwn(chosenLevel.counts,p.get('type'))?p.get('type'):null,
  zoom:num('zoom',1,.5,8),cx:num('cx',.5,0,1),cy:num('cy',.5,0,1),
  flags:reviewFlags.map((id,i)=>p.has(id)?p.get(id)==='1':i===0),revision:p.get('v')||DATA.meta.revision};
}
function reviewCenter() {
 const r=scene.getBoundingClientRect(),v=view.getBoundingClientRect();
 return {cx:Math.max(0,Math.min(1,(v.left+view.clientWidth/2-r.left)/(r.width||1))),cy:Math.max(0,Math.min(1,(v.top+view.clientHeight/2-r.top)/(r.height||1)))};
}
function currentViewHash() {
 const p=new URLSearchParams({v:DATA.meta.revision,level:String(level.id),candidate,
  scatter:String(typeof scatterIndex==='undefined'?1:scatterIndex+1),density:typeof densityProfile==='undefined'?'original':densityProfile});
 if(selected)p.set('instance',selected);if(typeHighlight)p.set('type',typeHighlight);
 for(const id of reviewFlags)p.set(id,$(id).checked?'1':'0');
 p.set('zoom',zoom.toFixed(3));if(level.available){const c=reviewCenter();p.set('cx',c.cx.toFixed(4));p.set('cy',c.cy.toFixed(4));}
 return '#'+p.toString();
}
function syncShareState() {
 if(reviewRestoring||!$('loading').hidden)return;
 const hash=currentViewHash();if(hash!==location.hash)history.replaceState(null,'',location.pathname+location.search+hash);
}
function reviewVersion(state) {
 $('versionNotice').hidden=state.revision===DATA.meta.revision;
 $('versionNotice').textContent='这个链接来自旧版布局。当前已加载最新版 '+DATA.meta.date+' / '+DATA.meta.revision+'，物件位置可能已有调整。';
}
async function reviewRestore(state) {
 selected=state.instance;typeHighlight=selected?null:state.type;zoom=state.zoom;
 reviewFlags.forEach((id,i)=>$(id).checked=state.flags[i]);
 renderCounts();renderInspector();draw();updateSize();
 await new Promise(resolve=>requestAnimationFrame(resolve));
 const r=scene.getBoundingClientRect(),v=view.getBoundingClientRect();
 view.scrollLeft+=r.left+r.width*state.cx-v.left-view.clientWidth/2;
 view.scrollTop+=r.top+r.height*state.cy-v.top-view.clientHeight/2;
 reviewVersion(state);
}
function reviewApplySelection(state) {
 level=DATA.levels.find(l=>l.id===state.level);candidate=state.candidate;
 if(typeof scatterIndex!=='undefined')scatterIndex=state.scatter;
 if(typeof densityProfile!=='undefined')densityProfile=state.density;
 if($('level').options.length)$('level').value=level.id;
}
const reviewOriginalSwitch=switchScene;
switchScene=async function(state=null){
 const sequence=++reviewGeneration;reviewRestoring=true;
 await reviewOriginalSwitch();
 if(sequence!==reviewGeneration)return;
 if(state&&report)await reviewRestore(state);
 reviewRestoring=false;syncShareState();
};
const reviewOriginalDraw=draw;
draw=function(){reviewOriginalDraw();syncShareState();};
function reviewToast(message){clearTimeout(reviewToastTimer);$('toast').textContent=message;$('toast').hidden=false;reviewToastTimer=setTimeout(()=>$('toast').hidden=true,3500);}
function viewURL(){return location.origin+location.pathname+location.search+currentViewHash();}
async function reviewCopy(text,message){
 let timer;try{await Promise.race([navigator.clipboard.writeText(text),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('clipboard')),1500))]);reviewToast(message);}
 catch{$('copyText').value=text;$('copyDialog').showModal();$('copyText').focus();$('copyText').select();}
 finally{clearTimeout(timer);}
}
$('shareView').onclick=()=>reviewCopy(viewURL(),'已复制当前地形、散布和物件位置');
$('copyDiscussion').onclick=()=>{
 const row=report?.instances.find(r=>r.instance_id===selected);
 const lines=['场景布局审阅 · '+level.name+' / '+candidate+' '+DATA.candidates[candidate].name,
  '版本：'+DATA.meta.date+' / '+DATA.meta.revision,
  '散布：'+(typeof scatterIndex==='undefined'?1:scatterIndex+1)+(typeof densityProfile==='undefined'?'':'；疏密：'+DATA.densityProfiles[densityProfile].name)];
 if(row)lines.push('物件：'+row.name+' / '+row.instance_id,'坐标：'+row.bbox.slice(0,2).join(', ')+'；前景保留：'+(row.visibility*100).toFixed(2)+'%');
 if(report)lines.push('数量：'+report.renderedTotal+' / '+report.expectedTotal);
 lines.push('查看位置：'+viewURL());reviewCopy(lines.join('\n'),'已复制讨论摘要及视图链接');
};
view.addEventListener('scroll',()=>{clearTimeout(reviewScrollTimer);reviewScrollTimer=setTimeout(syncShareState,180);},{passive:true});
for(const id of ['zoomIn','zoomOut','fit'])$(id).addEventListener('click',()=>requestAnimationFrame(syncShareState));
window.addEventListener('hashchange',async()=>{const state=parseViewState();reviewApplySelection(state);await switchScene(state);reviewVersion(state);});
const reviewInitialState=parseViewState();reviewApplySelection(reviewInitialState);reviewVersion(reviewInitialState);
$('revisionBadge').textContent=DATA.meta.date+' · '+DATA.meta.revision.slice(0,6);
$('revisionBadge').title='更新时间 '+DATA.meta.updatedAt+' · '+DATA.meta.revision;
const reviewInit=init;
init=async function(){await reviewInit();if(report)await reviewRestore(reviewInitialState);reviewRestoring=false;syncShareState();};
async function checkWebsiteUpdate(){
 if(document.visibilityState!=='visible')return;
 try{const response=await fetch('version.json?check='+Date.now(),{cache:'no-store'});if(!response.ok)return;const latest=await response.json();
  if(latest.revision&&latest.revision!==DATA.meta.revision){reviewToast('发现新版布局，正在更新…');setTimeout(()=>location.reload(),1000);}
 }catch{/* Keep the current review usable while the connection is unavailable. */}
}
setInterval(checkWebsiteUpdate,60000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')checkWebsiteUpdate();});
init();
