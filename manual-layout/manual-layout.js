/* Two explicit manual stages. Sliders never invoke generation or placement. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id),copy=value=>JSON.parse(JSON.stringify(value));
  const categories={building:'建筑',facility:'设施',character:'角色',vehicle:'载具'};
  const fmt=value=>Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:2});
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const apiRoot='/api/manual-layout';
  const sourceCanvas=$('sourceCanvas'),layoutCanvas=$('layoutCanvas');
  let state=null,model=null,catalog={},policy=null,token='',pictures={},factors={},prototypeFactors={},moves={};
  let selectedId=null,category='building',prototypeId=null,dirty=false,busy=false,undo=[],redo=[],gesture=null;
  let drawQueued=false,pollTimer=null,polling=false,jobRunning=false,serverValidation=null,currentJob=null;
  const camera={zoom:1,x:0,y:0},pointers=new Map();let interaction=null;
  const sourceSize=()=>state.source_size||[1254,1254],canvasSize=()=>state.canvas||[4096,4096];
  const inBase=()=>state?.phase==='base'||state?.phase==='stage1';
  const rows=()=>model?.instances||[];
  const chosen=()=>rows().find(item=>item.instance_id===selectedId);
  const entry=item=>catalog[item.prototype_id];
  const standard=id=>policy?.sizes?.[id];
  const factor=id=>(factors[catalog[id]?.category||rows().find(item=>item.prototype_id===id)?.category||id.split('-')[0]]??1)*(prototypeFactors[id]??1);
  const isSupplement=item=>!!item.is_supplemental||item.placement_source==='supplemental'||item.placement_source==='plugin_supplement';
  const feedback=(text,error=false)=>{$('feedback').textContent=text;$('feedback').classList.toggle('error',error);};
  const actionId=()=>globalThis.crypto?.randomUUID?.()||`manual-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const draftKey=()=>`tmc-manual-layout-draft-v1:${state.workspace_id||state.session_id||state.project_id||'grand-canyon'}`;
  function anchorFraction(item){
    const asset=entry(item),crop=asset?.alpha_crop||standard(item.prototype_id)?.alpha_crop_native;
    let [u,v]=item.native_support_override&&crop?[(item.native_support_override[0]-crop[0])/(crop[2]-crop[0]),(item.native_support_override[1]-crop[1])/(crop[3]-crop[1])]:asset?.anchor_fraction||standard(item.prototype_id)?.anchor_fraction||[.5,1];
    if(item.mirror_x)u=1-u;return [u,v];
  }
  function recompute(item){
    const size=standard(item.prototype_id);if(!size)throw new Error(`原型 ${item.prototype_id} 缺少统一基准尺寸。`);
    const f=factor(item.prototype_id),w=size.width*f,h=size.height*f,[u,v]=anchorFraction(item),[x,y]=item.delivery_anchor;
    item.render_bbox=[x-u*w,y-v*h,x+(1-u)*w,y+(1-v)*h];
  }
  function recomputeAll(){rows().forEach(recompute);}
  function snapshot(){return copy({model,factors,prototypeFactors,moves,dirty,selectedId,category,prototypeId});}
  function restoreSnapshot(value){({model,factors,prototypeFactors,moves,dirty,selectedId,category,prototypeId}=copy(value));dirty=true;cacheDraft();update();scheduleDraw();}
  function beginGesture(kind){if(!gesture)gesture={kind,before:snapshot()};}
  function finishGesture(){
    if(!gesture)return;const before=gesture.before;gesture=null;
    if(JSON.stringify([before.model,before.factors,before.prototypeFactors,before.moves])!==JSON.stringify([model,factors,prototypeFactors,moves])){undo.push(before);redo=[];dirty=true;cacheDraft();}
    update();scheduleDraw();
  }
  function cacheDraft(){
    if(!state)return;try{localStorage.setItem(draftKey(),JSON.stringify({schema:'tmc-manual-layout-draft.v1',server_revision:state.revision,server_state_hash:state.state_hash,phase:state.phase,saved_at:new Date().toISOString(),draft:snapshot()}));}catch{feedback('本机缓存不可写；请导出 JSON 或保存到本地布局服务。',true);}
  }
  async function request(path,body){
    if(window.manualLayoutTransport)return window.manualLayoutTransport.request(path,body);
    const response=await fetch(apiRoot+path,{method:body?'POST':'GET',cache:'no-store',headers:body?{'Content-Type':'application/json','X-Stage3-Token':token}:{},...(body?{body:JSON.stringify(body)}:{})});
    let data;try{data=await response.json();}catch{throw new Error(`布局服务返回非 JSON（${response.status}）。`);}
    if(!response.ok||data.ok===false)throw new Error(data.error?.message||data.error||data.message||`请求失败 ${response.status}`);
    return data;
  }
  function extractState(value){return value?.state||value?.data?.state||(value?.phase&&(value.base_model||value.model)?value:null);}
  async function adoptResponse(value){const next=extractState(value);await adopt(next||extractState(await request('/state')));return value;}
  async function loadImage(src){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error(src));img.src=src;});}
  async function ensurePictures(){
    const wanted={source:state.source_image,clean:state.clean_image,...Object.fromEntries(Object.entries(catalog).filter(([,asset])=>asset.src).map(([id,asset])=>[id,asset.src])),...Object.fromEntries((model.visual_foreground_layers||[]).map(layer=>[layer.id,layer.src]))};
    const results=await Promise.allSettled(Object.entries(wanted).map(async([key,src])=>{if(!src)return;if(pictures[key]?.src===src||pictures[key]?.getAttribute?.('src')===src)return;const img=await loadImage(src);pictures[key]=img;}));
    if(results.some(result=>result.status==='rejected'))feedback('部分图片无法加载；数量与坐标仍保留，请检查素材路径后再检验。',true);
  }
  async function adopt(next){
    if(!next)throw new Error('缺少布局服务 state。');state=copy(next);token=state.token||state.csrf_token||token;
    catalog=state.catalog?.prototypes||state.catalog||{};
    const base=state.base_model||state.model,active=state.active_model||state.model;
    model=copy(inBase()?base:(active||base));if(!Array.isArray(model?.instances))throw new Error('state 缺少实例模型。');
    policy=state.policy||state.prototype_size_policy||model.prototype_size_policy||model.coordinate_model?.prototype_size_policy||base?.prototype_size_policy||base?.coordinate_model?.prototype_size_policy;
    if(policy?.mode!=='uniform_by_prototype'||!policy.sizes)throw new Error('当前服务没有同原型统一尺寸政策，不能退回逐实例缩放。');
    factors={building:1,facility:1,character:1,vehicle:1,...state.plan?.category_factors};prototypeFactors={...state.plan?.prototype_factors};moves={};
    rows().forEach(item=>{if(!standard(item.prototype_id))throw new Error(`${item.prototype_id} 不在标准尺寸政策内。`);});
    recomputeAll();selectedId=rows().some(item=>item.instance_id===selectedId)?selectedId:null;
    if(!Object.keys(categories).includes(category))category='building';
    prototypeId=rows().find(item=>item.category===category&&item.prototype_id===prototypeId)?.prototype_id||rows().find(item=>item.category===category)?.prototype_id||null;
    dirty=false;undo=[];redo=[];gesture=null;serverValidation=state.validation;currentJob=state.job||state.jobs?.at?.(-1)||currentJob;
    await ensurePictures();update();scheduleDraw();
  }
  function markChanged(){dirty=true;serverValidation={status:'stale',message:'人工尺寸或位置已修改，之前的检查与补量结果需要重新检验。'};updateValidation();$('revisionLabel').textContent=`修订 ${state.revision} · 未保存`;if(!inBase()){$('phaseNotice').classList.add('stale');$('phaseNotice').textContent='阶段2：当前大小已实时修改，旧补量与检查已过期。所有已有与补充锚点不变；请保存后重新补量或检验。';}}
  function liveScale(event,type){
    if(!state||busy)return;const id=type==='category'?category:prototypeId;if(!id)return;
    if(category==='vehicle'&&!rows().some(item=>item.category==='vehicle'))return;
    const raw=Number(event.target.value);if(!Number.isFinite(raw)||event.target.value==='')return;
    beginGesture('scale');const percent=Math.max(25,Math.min(200,Math.round(raw)));
    if(type==='category')factors[id]=percent/100;else prototypeFactors[id]=percent/100;
    recomputeAll();markChanged();updateScaleFields(event.target);updateSelection();scheduleDraw();
    feedback('大小已实时更新；所有同原型已有与补充实例一致。尚未保存，未自动补量或重排。');
  }
  function updateScaleFields(active){
    const categoryPercent=Math.round((factors[category]??1)*100),prototypePercent=Math.round((prototypeFactors[prototypeId]??1)*100);
    $('categoryRange').value=categoryPercent;if(active!==$('categoryNumber'))$('categoryNumber').value=categoryPercent;
    $('prototypeRange').value=prototypePercent;if(active!==$('prototypeNumber'))$('prototypeNumber').value=prototypePercent;
    const size=standard(prototypeId),count=rows().filter(item=>item.prototype_id===prototypeId).length,f=prototypeId?factor(prototypeId):1;
    const body=size?.body_height_delivery??size?.body_reference?.delivery_height;
    $('sizeInfo').textContent=size?`${catalog[prototypeId]?.code||prototypeId} 全图 ${count} 件：4096 主体 ${fmt(size.width*f)} × ${fmt(size.height*f)} px。${body?` 身体标尺 ${fmt(body*f)} px；帽具保持完整比例。`:''}`:category==='vehicle'?'本关目标载具为 0，载具控制已禁用。':'本类别没有实例。';
    $('categoryLegend').textContent=`${categories[category]}整体大小`;
    $('supportWarning').hidden=!rows().some(item=>(item.prototype_id==='building-06'||item.source_support_dependents?.length)&&(item.category===category||item.prototype_id===prototypeId));
  }
  function updateSelection(){
    const item=chosen();if(!item){$('selection').textContent=inBase()?'点击建筑选择，可直接拖动。':'点击任一实例查看。补量阶段只调整大小，保持所有锚点。';return;}
    const b=item.render_bbox,source=item.source_anchor;
    $('selection').innerHTML=`<b>${esc(catalog[item.prototype_id]?.code||item.prototype_id)} ${esc(catalog[item.prototype_id]?.name||item.display_name||'')}</b><br>${esc(item.instance_id)}<br>来源：${isSupplement(item)?'插件补充':'基础来源'}<br>当前4096锚点：(${item.delivery_anchor.map(fmt).join(', ')})${source?`<br>原图测量锚点：(${source.map(fmt).join(', ')})`:''}<br>当前主体：${fmt(b[2]-b[0])} × ${fmt(b[3]-b[1])} px<br>方向：${item.mirror_x?'水平翻转':'保留原方向'}${item.prototype_id==='building-06'||item.source_support_dependents?.length?'<br><span class="warning">承载设施锚点固定，父建筑修改后需复核支撑。</span>':''}`;
  }
  const numeric=(row,names,fallback=0)=>{for(const key of names)if(Number.isFinite(Number(row[key])))return Number(row[key]);return fallback;};
  function countRows(){
    if(Array.isArray(state.counts))return state.counts;
    if(state.counts&&typeof state.counts==='object')return Object.entries(state.counts).map(([prototype_id,value])=>({prototype_id,...value}));
    return Object.keys(catalog).filter(id=>catalog[id].required_count!==undefined).map(prototype_id=>({prototype_id,existing:rows().filter(item=>item.prototype_id===prototype_id&&!isSupplement(item)).length,supplemental:rows().filter(item=>item.prototype_id===prototype_id&&isSupplement(item)).length,target:catalog[prototype_id].required_count}));
  }
  function updateCounts(){
    const table=countRows();let target=0,total=0,missing=0,overage=0;
    $('countRows').innerHTML=table.map(row=>{const id=row.prototype_id||row.id,existing=numeric(row,['existing','base','source','source_count','observed','original']),added=numeric(row,['supplemental','added','supplemental_count']),goal=numeric(row,['target','required','required_count']),deficit=numeric(row,['deficit','missing'],Math.max(0,goal-existing-added)),extra=numeric(row,['overage','excess'],Math.max(0,existing+added-goal));target+=goal;total+=existing+added;missing+=Math.max(0,deficit);overage+=Math.max(0,extra);return `<tr><td title="${esc(catalog[id]?.name||id)}">${esc(row.disabled&&row.category==='vehicle'?'载具（禁用）':catalog[id]?.code||id)}</td><td>${existing}</td><td>${added}</td><td>${goal}</td><td class="${deficit||extra?'deficit':''}">${extra?'超 '+extra:deficit}</td></tr>`;}).join('');
    const archived=inBase()&&state.active_model?.instances?.length>rows().length;
    $('countSummary').textContent=`${archived?'上轮补量保留参考；基础画面只展示 '+rows().length+' 件。':''}当前保存结果 ${total} / 策划应有 ${target}，缺额 ${missing}${overage?'，超额 '+overage:''}。寻物目标 ${state.source_contract?.target_total??21} 件包含在应有总数中，不额外相加。${missing||overage?'数量冲突保留记录；不足由人工调整后再补齐，不会自动缩小或删除素材。':'数量齐全仍需检查地形、支撑、寻物目标和叠放。'}`;
  }
  function linksInto(id,links){$(id).innerHTML=Object.entries(links||{}).filter(([,url])=>typeof url==='string'&&url&&!url.startsWith('javascript:')).map(([name,url])=>`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(({render:'插件预览',validation:'插件检查结果',command_log:'实际调用记录',provenance:'来源记录',json:'当前JSON'})[name]||name)}</a>`).join('');}
  function updateValidation(){
    const result=serverValidation||{},status=dirty||state.supplemental_stale?'stale':result.status||(result.schema==='manual-layout-validation.v1'?(result.supplemental_stale?'stale':!result.structural_counts_complete||result.canvas_projection_ids?.length?'blocked':'structural_pending'):'pending');
    const labels={pending:'待检查',stale:'检查已过期',running:'检查中',pass:'技术检查通过 · 待人工复核',passed:'技术检查通过 · 待人工复核',fail:'检查未通过',failed:'检查未通过',blocked:'检查已运行 · 仍有阻塞项',partial:'未满足全部要求',structural_pending:'结构数量已齐 · 地形/支撑待复核'};
    $('validationStatus').textContent=labels[status]||'待复核';$('validationStatus').className='badge'+(['pass','passed'].includes(status)?'':['fail','failed','blocked'].includes(status)?' fail':' pending');
    $('validationDetail').textContent=(dirty?'位置或大小尚未保存。':result.schema==='manual-layout-validation.v1'?`当前 ${result.total} / ${result.required_total}，目标 ${result.target_total} / ${result.required_target_total}，超画布 ${result.canvas_projection_ids?.length||0} 件。地形与承载仍待复核。`:result.message||result.summary||'尚无当前修订的插件检查结论。')+' 预览与技术结果均不代表正式交付。';
    linksInto('validationLinks',result.artifacts||result.links||(result.url?{validation:result.url}:{}));
  }
  function updateJob(){
    const job=currentJob;$('jobPanel').hidden=!job;if(!job)return;
    const status=job.status||job.state||'pending',isValidation=job.kind==='validate',deficit=countRows().reduce((sum,row)=>sum+numeric(row,['deficit','missing']),0);$('jobTitle').textContent=({queued:'插件任务等待中',running:isValidation?'插件正在检验当前布局':'插件正在补齐数量',partial:isValidation?'插件检查存在未满足项':deficit?`插件补量缺额 ${deficit} 件 · 请人工调整`:'数量已补齐 · 检查仍有未满足项',failed:'插件任务失败',succeeded:'插件任务已返回 · 仍需复核',completed:'插件任务已返回 · 仍需复核'})[status]||'插件任务状态';
    $('jobProgress').value=Number(job.progress??job.progress_detail?.progress)||0;$('jobMessage').textContent=job.message||job.error||job.progress_detail?.message||'';linksInto('jobLinks',job.artifacts||job.result?.artifacts||job.links);
  }
  function update(){
    if(!state)return;
    $('baseStage').classList.toggle('active',inBase());$('supplementStage').classList.toggle('active',!inBase());
    $('revisionLabel').textContent=`修订 ${state.revision}${dirty?' · 未保存':''}`;
    $('baseline').textContent=`${state.baseline_label||'当前人工布局基准'}。100% 直接使用该基准，不重复乘此前的缩放参数。`;
    $('phaseNotice').textContent=inBase()?`阶段1：当前 ${rows().length} 件表内采纳的基础来源${state.observation_ledger_count?'；完整 '+state.observation_ledger_count+' 条原图观察另库保留':''}。可拖动建筑；建筑、设施、角色均可统一缩放。确认后才运行真实插件补量。测量记录保留，人工移动另记修订，不将本页称为完整原图复原。`:`阶段2：查看插件返回的基础与补充实例。同原型大小全图一致；滑条不会自动重排。${dirty?'当前尺寸已修改，旧补量/检查过期，需保存后重新补量或检验。':'缺额、支撑或原图冲突仍需明确处理，当前不是正式交付。'}`;
    $('phaseNotice').classList.toggle('stale',dirty&&!inBase());$('renderLabel').textContent=`4096 坐标 · ${rows().length} 件${dirty?' · 未保存':''}`;
    for(const option of $('category').options||[])option.disabled=!rows().some(item=>item.category===option.value);
    $('category').value=category;
    const ids=[...new Set(rows().filter(item=>item.category===category).map(item=>item.prototype_id))];
    $('prototype').innerHTML=ids.map(id=>`<option value="${esc(id)}">${esc(catalog[id]?.code||id)} ${esc(catalog[id]?.name||id)}</option>`).join('');
    if(!ids.includes(prototypeId))prototypeId=ids[0]||null;$('prototype').value=prototypeId||'';
    const usable=!!ids.length&&!busy;$('categoryField').disabled=!usable;$('prototypeField').disabled=!usable;$('category').disabled=busy;$('prototype').disabled=!usable;
    $('undo').disabled=busy||!undo.length;$('redo').disabled=busy||!redo.length;
    for(const id of ['save','restore','confirm','validate','exportJson','exportPng'])$(id).disabled=busy;
    $('confirm').textContent=inBase()?'确认基础布局并补齐数量':'按当前统一尺寸重新补量';$('reopen').hidden=inBase();$('reopen').disabled=busy;
    if(state.runtime_mode==='shared-static'){
      $('confirm').disabled=true;$('validate').disabled=true;$('save').textContent='保存到此浏览器';
      $('phaseNotice').textContent+=' 在线共享版：改动只保存在各自浏览器。真实补量和插件检验需下载仓库在本机运行；可导出JSON交回本机。';
    }
    $('importJson').disabled=busy;
    updateScaleFields();updateSelection();updateCounts();updateValidation();updateJob();
  }
  function scheduleDraw(){if(drawQueued)return;drawQueued=true;requestAnimationFrame(()=>{drawQueued=false;draw();});}
  function worldToScreen(point,canvas){const unit=canvas.width/canvasSize()[0];return [(point[0]*camera.zoom+camera.x)*unit,(point[1]*camera.zoom+camera.y)*unit];}
  function screenToWorld(event,canvas){const rect=canvas.getBoundingClientRect(),size=canvasSize();return [((event.clientX-rect.left)/rect.width*size[0]-camera.x)/camera.zoom,((event.clientY-rect.top)/rect.height*size[1]-camera.y)/camera.zoom];}
  function drawScene(ctx,{source=false,preview=false}={}){
    const canvas=ctx.canvas,[w,h]=canvasSize();ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#dfd5c1';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.save();ctx.scale(canvas.width/w,canvas.height/h);if(!preview){ctx.translate(camera.x,camera.y);ctx.scale(camera.zoom,camera.zoom);}
    const background=pictures[source?'source':'clean'];if(background)ctx.drawImage(background,0,0,w,h);
    if(!source){
      rows().slice().sort((a,b)=>(a.render_order??a.delivery_anchor[1])-(b.render_order??b.delivery_anchor[1])).forEach(item=>{
        const b=item.render_bbox,img=pictures[item.prototype_id],asset=entry(item);if(!img||!asset)return;const crop=asset.alpha_crop||[0,0,img.naturalWidth,img.naturalHeight];
        ctx.save();ctx.translate(item.mirror_x?b[2]:b[0],b[1]);if(item.mirror_x)ctx.scale(-1,1);ctx.drawImage(img,crop[0],crop[1],crop[2]-crop[0],crop[3]-crop[1],0,0,b[2]-b[0],b[3]-b[1]);ctx.restore();
      });
      for(const layer of model.visual_foreground_layers||[])if(pictures[layer.id])ctx.drawImage(pictures[layer.id],0,0,w,h);
    }
    if(!preview)for(const item of rows()){
      const selected=item.instance_id===selectedId;if(source&&isSupplement(item))continue;
      let b=item.render_bbox,a=item.delivery_anchor;
      if(source){if(!item.source_bbox)continue;b=item.source_bbox.map((value,i)=>value*(canvasSize()[i%2]/sourceSize()[i%2]));a=item.source_anchor?.map((value,i)=>value*(canvasSize()[i]/sourceSize()[i]));}
      const color=selected?'#f9db4b':isSupplement(item)?'#cd8c34':'#3d8068';ctx.lineWidth=(selected?8:4)/camera.zoom;ctx.strokeStyle=color;
      if($('showBoxes').checked||selected)ctx.strokeRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);
      if(a&&($('showAnchors').checked||selected)){ctx.beginPath();ctx.arc(a[0],a[1],10/camera.zoom,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.strokeStyle='#fff9e9';ctx.lineWidth=3/camera.zoom;ctx.stroke();}
    }
    ctx.restore();
  }
  function draw(){if(!state)return;drawScene(layoutCanvas.getContext('2d'));if($('showOriginal').checked)drawScene(sourceCanvas.getContext('2d'),{source:true});}
  function selectItem(item){if(!item)return;selectedId=item.instance_id;category=item.category;prototypeId=item.prototype_id;update();scheduleDraw();}
  function hitAt(point,source=false){return rows().slice().sort((a,b)=>(b.render_order??b.delivery_anchor[1])-(a.render_order??a.delivery_anchor[1])).find(item=>{if(source&&isSupplement(item))return false;const b=source?item.source_bbox?.map((value,i)=>value*(canvasSize()[i%2]/sourceSize()[i%2])):item.render_bbox;return b&&point[0]>=b[0]&&point[0]<=b[2]&&point[1]>=b[1]&&point[1]<=b[3];});}
  function setZoom(value,center=[canvasSize()[0]/2,canvasSize()[1]/2]){
    const previous=camera.zoom,next=Math.max(1,Math.min(4,value));camera.x=center[0]-(center[0]-camera.x)*next/previous;camera.y=center[1]-(center[1]-camera.y)*next/previous;camera.zoom=next;$('zoom').value=String([1,1.5,2,3].includes(next)?next:1);scheduleDraw();
  }
  function pointerDown(event,canvas,source){
    if(!state)return;canvas.setPointerCapture?.(event.pointerId);pointers.set(event.pointerId,{x:event.clientX,y:event.clientY,canvas});
    if(pointers.size===2){finishGesture();const values=[...pointers.values()];interaction={kind:'pinch',distance:Math.hypot(values[0].x-values[1].x,values[0].y-values[1].y),zoom:camera.zoom};return;}
    const point=screenToWorld(event,canvas),item=hitAt(point,source);if(item)selectItem(item);
    if(!source&&!busy&&inBase()&&item?.category==='building'&&!$('panMode').checked&&event.button!==1){
      beginGesture('move');interaction={kind:'move',id:item.instance_id,start:point,anchor:copy(item.delivery_anchor)};
      if(item.prototype_id==='building-06'||item.source_support_dependents?.length)feedback('正在人工移动承载建筑；屋顶设施锚点不会跟随移动，完成后必须重新检查支撑。');
    }else interaction={kind:'pan',start:[event.clientX,event.clientY],camera:[camera.x,camera.y],canvas};canvas.classList.add('dragging');
  }
  function pointerMove(event,canvas){
    if(!interaction||!pointers.has(event.pointerId))return;pointers.set(event.pointerId,{x:event.clientX,y:event.clientY,canvas});
    if(interaction.kind==='pinch'&&pointers.size>=2){const values=[...pointers.values()],distance=Math.hypot(values[0].x-values[1].x,values[0].y-values[1].y);setZoom(interaction.zoom*distance/Math.max(1,interaction.distance));return;}
    if(interaction.kind==='move'){
      const item=rows().find(row=>row.instance_id===interaction.id),point=screenToWorld(event,canvas),[w,h]=canvasSize();if(!item)return;
      item.delivery_anchor=[Math.max(0,Math.min(w,interaction.anchor[0]+point[0]-interaction.start[0])),Math.max(0,Math.min(h,interaction.anchor[1]+point[1]-interaction.start[1]))];moves[item.instance_id]=copy(item.delivery_anchor);recompute(item);markChanged();updateSelection();scheduleDraw();
    }else if(interaction.kind==='pan'){
      const rect=canvas.getBoundingClientRect();camera.x=interaction.camera[0]+(event.clientX-interaction.start[0])/rect.width*canvasSize()[0];camera.y=interaction.camera[1]+(event.clientY-interaction.start[1])/rect.height*canvasSize()[1];scheduleDraw();
    }
  }
  function pointerUp(event,canvas){pointers.delete(event.pointerId);canvas.classList.remove('dragging');if(!pointers.size){interaction=null;finishGesture();}else if(interaction?.kind==='pinch')interaction=null;}
  function download(blob,name){const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function exported(){return {schema:'tmc-manual-layout-preview.v1',baseline_revision:policy.revision,phase:state.phase,revision:state.revision,server_state_hash:state.state_hash,unsaved:dirty,model:copy(model),plan:{category_factors:copy(factors),prototype_factors:copy(prototypeFactors),moves:copy(moves)},counts:copy(state.counts),validation:copy(serverValidation||{}),formal_complete:false,visual_approval:false};}
  function importPlan(value){
    if(!inBase())throw new Error('请先返回基础阶段，再导入尺寸与基础建筑位置。原补量保留在历史中，不直接导入补充件。');
    if(value.schema!=='tmc-manual-layout-preview.v1'||value.baseline_revision!==policy.revision)throw new Error('导入文件不是同一素材基准的人工布局JSON。');
    const incoming=value.model?.instances;if(!Array.isArray(incoming))throw new Error('导入文件缺少实例。');
    const mapped=new Map(incoming.map(item=>[item.instance_id,item]));if(mapped.size!==incoming.length)throw new Error('导入实例ID重复。');
    const nextFactors={...factors},nextPrototype={...prototypeFactors},nextMoves={};
    const checkedFactor=v=>{if(typeof v!=='number'||!Number.isFinite(v)||v<.25||v>2)throw new Error('导入倍率超出25%—200%。');return v;};
    for(const [key,v]of Object.entries(value.plan?.category_factors||{})){if(!(key in categories))throw new Error('导入类别未知。');if(key==='vehicle'){if(v!==1)throw new Error('本关载具为0。');continue;}nextFactors[key]=checkedFactor(v);}
    for(const [key,v]of Object.entries(value.plan?.prototype_factors||{})){if(!catalog[key])throw new Error('导入原型未知。');nextPrototype[key]=checkedFactor(v);}
    for(const item of rows()){
      const other=mapped.get(item.instance_id);
      if(!other||other.prototype_id!==item.prototype_id||other.mirror_x!==item.mirror_x||JSON.stringify(other.source_anchor)!==JSON.stringify(item.source_anchor))throw new Error('导入文件的基础身份、方向或测量记录不匹配。');
      const a=other.delivery_anchor;if(!Array.isArray(a)||a.length!==2||a.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>4096))throw new Error('导入锚点不合法。');
      if(item.category==='building')nextMoves[item.instance_id]=copy(a);
      else if(JSON.stringify(a)!==JSON.stringify(item.delivery_anchor))throw new Error('导入文件改变了非建筑锚点。');
    }
    undo.push(snapshot());redo=[];factors=nextFactors;prototypeFactors=nextPrototype;moves=nextMoves;
    for(const item of rows())if(nextMoves[item.instance_id])item.delivery_anchor=copy(nextMoves[item.instance_id]);
    recomputeAll();markChanged();cacheDraft();update();scheduleDraw();
    feedback('已导入尺寸和基础建筑位置，可撤销。没有导入补充件、修改数量或调用插件；确认后再补量。');
  }
  async function saveDraft(){finishGesture();const body={revision:state.revision,action_id:actionId(),moves:copy(moves),category_factors:Object.fromEntries(Object.entries(factors).filter(([key])=>key!=='vehicle')),prototype_factors:copy(prototypeFactors)};await adoptResponse(await request('/save',body));try{localStorage.removeItem(draftKey());}catch{}feedback(state.runtime_mode==='shared-static'?'草稿已保存到此浏览器。请导出JSON交回本机；未上传其他人的工作区，也未运行插件。':'草稿已保存到本地布局服务。当前修订仍需插件检查与人工确认。');}
  async function withBusy(operation){if(busy)return;busy=true;update();try{await operation();}catch(error){feedback(error.message,true);}finally{if(!jobRunning)busy=false;update();}}
  async function pollJob(jobId){
    if(polling)return;polling=true;jobRunning=true;busy=true;update();
    try{
      const result=await request('/status'+(jobId?'?job_id='+encodeURIComponent(jobId):''));currentJob=result.job||result.status_record||result;
      if(extractState(result))await adopt(extractState(result));
      const status=currentJob.status||currentJob.state,isValidation=currentJob.kind==='validate';
      if(currentJob.stale){polling=false;jobRunning=false;busy=false;feedback('任务属于已过期的布局修订，结果保留但未覆盖当前草稿。请按当前尺寸重新确认补量或重新检验。',true);update();return;}
      if(['succeeded','partial','completed'].includes(status)){
        await adoptResponse(await request('/apply',{revision:state.revision,action_id:actionId(),job_id:jobId||currentJob.job_id||currentJob.id}));polling=false;jobRunning=false;busy=false;
        const deficit=countRows().reduce((sum,row)=>sum+numeric(row,['deficit','missing']),0);
        feedback(isValidation?'插件检查已返回，结果与未满足项均已保留。没有移动、缩放或补充任何实例。':deficit?`插件已返回布局，仍缺 ${deficit} 件。请人工调整后重新补量；没有自动缩小素材。`:status==='partial'?'数量已补齐，检查仍有未满足项。请继续复核地形、叠放与画面；当前不是正式通过。':'插件补量任务已返回，数量已补齐。请检查地形、支撑与画面，仍未正式交付。');
      }else if(['failed','cancelled','error'].includes(status)){polling=false;jobRunning=false;busy=false;feedback(currentJob.message||currentJob.error||'插件补量失败，基础草稿与旧结果已保留。',true);}
      else{polling=false;pollTimer=setTimeout(()=>pollJob(jobId),1200);}
    }catch(error){polling=false;jobRunning=false;busy=false;feedback(`读取插件任务失败：${error.message}。刷新后可从已保存任务继续查看。`,true);}
    update();
  }
  async function confirmAndSupplement(){await withBusy(async()=>{await saveDraft();await adoptResponse(await request('/freeze',{revision:state.revision,action_id:actionId()}));const result=await request('/supplement',{revision:state.revision,action_id:actionId()});if(extractState(result))await adopt(extractState(result));currentJob=result.job||state.job||{status:'queued',message:'基础布局已冻结，等待实际插件补量。'};feedback('基础锚点和统一尺寸已保存并冻结；正在调用真实插件补量。');polling=false;await pollJob(result.job_id||currentJob.job_id||currentJob.id);});}
  async function init(){
    try{
      await adopt(extractState(await request('/state')));feedback('已载入当前人工基准。拖动建筑或调整统一大小，确认后再运行补量。');
      $('showOriginal').addEventListener('change',()=>{$('originalFigure').hidden=!$('showOriginal').checked;$('canvases').classList.toggle('single',!$('showOriginal').checked);scheduleDraw();});['showBoxes','showAnchors'].forEach(id=>$(id).addEventListener('change',scheduleDraw));
      $('category').addEventListener('change',()=>{finishGesture();category=$('category').value;prototypeId=null;selectedId=rows().find(item=>item.category===category)?.instance_id||null;update();scheduleDraw();});
      $('prototype').addEventListener('change',()=>{finishGesture();prototypeId=$('prototype').value;selectedId=rows().find(item=>item.prototype_id===prototypeId)?.instance_id;update();scheduleDraw();});
      for(const [prefix,type]of [['category','category'],['prototype','prototype']])for(const suffix of ['Range','Number']){$(prefix+suffix).addEventListener('input',event=>liveScale(event,type));$(prefix+suffix).addEventListener('change',finishGesture);}
      $('undo').addEventListener('click',()=>{if(busy)return;finishGesture();if(!undo.length)return;redo.push(snapshot());restoreSnapshot(undo.pop());feedback('已撤销一次拖动或统一尺寸手势；未调用补量。');});
      $('redo').addEventListener('click',()=>{if(busy)return;if(!redo.length)return;undo.push(snapshot());restoreSnapshot(redo.pop());});
      $('save').addEventListener('click',()=>withBusy(saveDraft));$('restore').addEventListener('click',()=>{if(busy)return;try{const saved=JSON.parse(localStorage.getItem(draftKey())||'null');if(!saved){feedback('本机没有未保存草稿。');return;}if(saved.server_revision!==state.revision||saved.server_state_hash!==state.state_hash||saved.phase!==state.phase){feedback('本机草稿属于旧服务端修订，不能覆盖当前布局；请先导出并核对版本。',true);return;}undo.push(snapshot());restoreSnapshot(saved.draft);feedback('已恢复本机未保存草稿；尚未写入服务端或调用插件。');}catch(error){feedback(`恢复失败：${error.message}`,true);}});
      $('confirm').addEventListener('click',confirmAndSupplement);$('validate').addEventListener('click',()=>withBusy(async()=>{await saveDraft();const result=await request('/validate',{revision:state.revision,action_id:actionId()});await adoptResponse(result);const job=state.job||result.job;if(job&&['queued','running'].includes(job.status)){currentJob=job;await pollJob(result.job_id||job.job_id||job.id);}else{if(result.validation)serverValidation=result.validation;update();feedback('已读取当前修订的检查结果；未自动调整大小、位置或数量。');}}));
      $('reopen').addEventListener('click',()=>withBusy(async()=>{if(dirty)await saveDraft();await adoptResponse(await request('/reopen',{revision:state.revision,action_id:actionId()}));feedback('已建立新的基础修订。旧补量结果保留在历史中，未删除观察记录。');}));
      $('exportJson').addEventListener('click',()=>{finishGesture();download(new Blob([JSON.stringify(exported(),null,2)],{type:'application/json'}),`grand-canyon-manual-r${state.revision}${dirty?'-draft':''}.json`);});
      $('importJson').addEventListener('click',()=>$('importFile').click());
      $('importFile').addEventListener('change',async event=>{try{const file=event.target.files?.[0];if(!file)return;if(file.size>8*1024*1024)throw new Error('导入JSON超过8 MB。');importPlan(JSON.parse(await file.text()));}catch(error){feedback(error.message,true);}finally{event.target.value='';}});
      $('exportPng').addEventListener('click',()=>{finishGesture();const canvas=document.createElement('canvas');[canvas.width,canvas.height]=canvasSize();drawScene(canvas.getContext('2d'),{preview:true});canvas.toBlob(blob=>{if(blob)download(blob,`grand-canyon-manual-r${state.revision}-preview.png`);});});
      $('zoom').addEventListener('change',()=>setZoom(Number($('zoom').value)));$('fit').addEventListener('click',()=>{camera.zoom=1;camera.x=camera.y=0;$('zoom').value='1';scheduleDraw();});
      for(const [canvas,source]of [[sourceCanvas,true],[layoutCanvas,false]]){canvas.addEventListener('pointerdown',event=>pointerDown(event,canvas,source));canvas.addEventListener('pointermove',event=>pointerMove(event,canvas));canvas.addEventListener('pointerup',event=>pointerUp(event,canvas));canvas.addEventListener('pointercancel',event=>pointerUp(event,canvas));canvas.addEventListener('wheel',event=>{event.preventDefault();setZoom(camera.zoom*Math.exp(-event.deltaY*.001));},{passive:false});}
      window.addEventListener('beforeunload',()=>{if(dirty)cacheDraft();});
      window.manualLayout={getState:()=>copy(state),getModel:()=>copy(model),getDraft:()=>exported(),getCamera:()=>copy(camera),isBusy:()=>busy,importPlan};
      const job=state.job;if(job&&!job.stale&&(['queued','running'].includes(job.status)||job.applied===false&&['succeeded','partial','completed'].includes(job.status)))pollJob(job.job_id||job.id);
    }catch(error){feedback(`加载失败：${error.message}`,true);$('phaseNotice').textContent='布局服务尚未就绪；此页面没有运行补量，也不能视为完成。';}
  }
  init();
})();
