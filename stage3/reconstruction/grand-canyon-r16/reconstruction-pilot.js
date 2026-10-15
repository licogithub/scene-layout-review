/* Independent source-first pilot. Never reads or writes the legacy layout cache. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const round = value => Math.round(value * 100) / 100;
  const fmt = value => round(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const label = status => ({matched:'素材匹配',art_variant_substitution:'外观变体替代',pending_direction:'朝向待定',pending_asset:'待补素材',pending_group:'组合待复核',pending_partial_topology:'部分柱脚被遮挡',pending:'待复核',annotated_buildings:'建筑已标注',annotated_source_records:'源观察已记录',censused_empty:'建筑普查为空'})[status] || status || '待复核';
  const categoryName = {all:'全部观察',building:'建筑',facility:'设施·全部观察',facility_individual:'设施·已映射单件',vehicle:'载具',character:'角色',background_context:'背景结构候选',background_individual:'背景·已映射单件'};
  const operatorKind = new URLSearchParams(window.location.search).get('operator') === 'delegated' ? 'delegated' : 'local';
  const currentOperator = () => ({kind:operatorKind,label:operatorKind==='delegated'?'获授权代理复核':'浏览器当前操作者'});
  const ids = ['bboxX0','bboxY0','bboxX1','bboxY1','anchorX','anchorY'];
  let manifest, model, catalog, pictures = {}, regionId, selectedId;
  let category='all';
  let assetLoadErrors=[];
  let sizePolicyIdentity=null, cacheRejected=false;
  let local, undo = [], gesture = null, dirty = false;
  const sourceCanvas = $('sourceCanvas'), renderCanvas = $('renderCanvas');
  const sourceCtx = sourceCanvas.getContext('2d'), renderCtx = renderCanvas.getContext('2d');
  const currentInstances = () => model.instances.filter(item => (regionId==='all'||item.region_id === regionId) && (category==='all'||item.category===category||(category==='facility_individual'&&item.category==='facility'&&canFreeze(item))||(category==='background_individual'&&item.category==='background_context'&&canFreeze(item))));
  const selected = () => currentInstances().find(item => item.instance_id === selectedId);
  const coords = () => regionId==='all'?{source_bounds:[0,0,...sourceSize()],delivery_bounds:[0,0,...targetSize()],right_edge_inclusive:true,bottom_edge_inclusive:true}:(model.coordinate_model?.regions || []).find(item => item.region_id === regionId);
  const region = () => regionId==='all'?{name:'全图',region_id:'all',status:'annotated_source_records'}:model.regions.find(item => item.region_id === regionId);
  const sourceSize = () => manifest.source_size;
  const targetSize = () => manifest.canvas;
  const sizePolicy = () => model?.prototype_size_policy || model?.coordinate_model?.prototype_size_policy || null;
  const uniformSizes = () => sizePolicy()?.mode==='uniform_by_prototype';
  const policyTag = () => uniformSizes()?`:uniform-${encodeURIComponent(sizePolicy().revision)}`:'';
  const key = () => `tmc-source-first:${manifest.revision}${policyTag()}:${regionId}:${category}`;
  const geometryKey = () => `tmc-source-first:${manifest.revision}${policyTag()}:shared-geometry-${uniformSizes()?'v2':'v1'}`;
  const samePrototype = item => model.instances.filter(row=>row.prototype_id===item.prototype_id&&!row.source_primitive&&row.observation_semantics!=='group');
  const standardSize = item => sizePolicy()?.sizes?.[item.prototype_id];
  function policyIdentity(policy) {
    return JSON.stringify({mode:policy.mode,revision:policy.revision,coordinate_space:policy.coordinate_space,scope:policy.scope,sizes:Object.fromEntries(Object.entries(policy.sizes).sort(([a],[b])=>a.localeCompare(b)).map(([id,value])=>[id,{...value,scale_percent:undefined}]))});
  }
  function replacePolicy(value) {
    if(model.prototype_size_policy)model.prototype_size_policy=clone(value);
    else model.coordinate_model.prototype_size_policy=clone(value);
  }
  function validateUniformCache(rows,policy) {
    if(!policy||policyIdentity(policy)!==sizePolicyIdentity||rows.length!==model.instances.length)return false;
    const cached=new Map(rows.map(row=>[row.instance_id,row]));if(cached.size!==rows.length)return false;
    return model.instances.every(item=>{
      const row=cached.get(item.instance_id),standard=policy.sizes[item.prototype_id];
      if(!row||!standard||['prototype_id','source_bbox','source_anchor','delivery_anchor','mirror_x'].some(field=>JSON.stringify(row[field])!==JSON.stringify(item[field])))return false;
      const percent=standard.scale_percent??100;if(!Number.isFinite(percent)||percent<25||percent>200)return false;
      if(row.local_scale_percent!==percent||JSON.stringify(row.local_baseline_size)!==JSON.stringify([standard.width,standard.height]))return false;
      const [u,v]=assetAnchor(item),[x,y]=item.delivery_anchor,w=standard.width*percent/100,h=standard.height*percent/100;
      const expected=[x-u*w,y-v*h,x+(1-u)*w,y+(1-v)*h];
      return Array.isArray(row.render_bbox)&&row.render_bbox.length===4&&row.render_bbox.every((value,i)=>Number.isFinite(value)&&Math.abs(value-expected[i])<1e-8);
    });
  }
  function hasSupportDependents(item) {
    return !!item.source_support_dependents?.length||model.instances.some(child=>[child.parent_instance_id,child.stack_parent_id,child.stack_parent_instance_id,child.support_parent_id,child.carrier_instance_id].includes(item.instance_id));
  }
  function blockedPrototypeMembers(item) {return samePrototype(item).filter(row=>row.prototype_id==='building-06'||hasSupportDependents(row));}
  const scopeName = () => regionId==='all'?'全图':'本块';
  const reviewScope = () => regionId==='all'?(category==='all'?'current_map_only':'current_map_category_only'):(category==='all'?'current_region_only':'current_region_category_only');
  const geometryFields=['instance_id','prototype_id','source_bbox','source_anchor','delivery_anchor','render_bbox','mirror_x','local_baseline_size','local_scale_percent','anchor_locked','review_status','coordinate_evidence_status'];
  const geometry = item => Object.fromEntries(geometryFields.filter(field=>field in item).map(field=>[field,clone(item[field])]));
  function applyGeometry(rows) {
    const changes=new Map(rows.map(item=>[item.instance_id,item]));
    model.instances=model.instances.map(item=>{const change=changes.get(item.instance_id);if(!change||change.prototype_id!==item.prototype_id)return item;const next={...item};for(const field of geometryFields){if(field in change)next[field]=clone(change[field]);else delete next[field];}return next;});
  }
  function hydrateGeometry() {
    if(uniformSizes()) {
      // Never migrate old per-instance size edits into a standard-size candidate.
      try {
        const shared=JSON.parse(localStorage.getItem(geometryKey())||'null');
        if(shared){if(shared.manifest_revision===manifest.revision&&shared.prototype_size_policy_identity===sizePolicyIdentity&&Array.isArray(shared.instances)&&validateUniformCache(shared.instances,shared.prototype_size_policy)){applyGeometry(shared.instances);replacePolicy(shared.prototype_size_policy);}else cacheRejected=true;}
        const legacy=localStorage.getItem(`tmc-source-first:${manifest.revision}:shared-geometry-v1`);
        if(legacy)cacheRejected=true;
      }catch{cacheRejected=true;}
      return;
    }
    // Migrate previous regional edits once; all views then share one geometry.
    const saved=[];
    for(const id of ['all',...model.regions.map(r=>r.region_id)])for(const kind of Object.keys(categoryName)){
      try{const value=JSON.parse(localStorage.getItem(`tmc-source-first:${manifest.revision}:${id}:${kind}`)||'null');if(value?.manifest_revision===manifest.revision&&Array.isArray(value.instances))saved.push(value);}catch{}
    }
    saved.sort((a,b)=>(a.modified_at||a.local?.created_at||'').localeCompare(b.modified_at||b.local?.created_at||''));
    saved.forEach(value=>applyGeometry(value.instances));
    try{const shared=JSON.parse(localStorage.getItem(geometryKey())||'null');if(shared?.manifest_revision===manifest.revision&&Array.isArray(shared.instances))applyGeometry(shared.instances);}catch{}
  }
  const visibilityBlocked = item => item.render_visibility?.mostly_hidden || (String(item.render_visibility?.critical_proxy).includes('open rim') && (item.render_visibility.critical_proxy_visible_fraction||0)<.5);
  const canFreeze = item => !!pictures[item.prototype_id] && typeof item.mirror_x==='boolean' && !String(item.match_status).startsWith('pending') && item.observation_semantics!=='group' && !item.source_primitive && !visibilityBlocked(item) && !item.source_shape_conflict;
  const frozen = () => !!local?.frozen;
  const snapshot = () => clone({instances:(uniformSizes()?model.instances:currentInstances()).map(geometry),local,...(uniformSizes()?{prototype_size_policy:sizePolicy()}:{} )});
  const restore = value => {
    applyGeometry(clone(value.instances));if(uniformSizes()&&value.prototype_size_policy)replacePolicy(value.prototype_size_policy);local = clone(value.local);
    if (!selected()) selectedId = currentInstances()[0]?.instance_id;
  };
  const persist = () => {
    try {
      const modified_at=new Date().toISOString();
      const policyFields=uniformSizes()?{prototype_size_policy_identity:sizePolicyIdentity,prototype_size_policy:clone(sizePolicy())}:{};
      localStorage.setItem(geometryKey(),JSON.stringify({manifest_revision:manifest.revision,modified_at,instances:model.instances.map(geometry),...policyFields}));
      localStorage.setItem(key(), JSON.stringify({schema:'source-reconstruction-local.v3',region_id:regionId,manifest_revision:manifest.revision,modified_at,...snapshot(),...policyFields,selected_id:selectedId}));
    }
    catch (_) { feedback('浏览器无法保存缓存，请导出 JSON 保留本次修改。', true); }
  };
  const feedback = (message, error = false) => { $('feedback').textContent = message; $('feedback').classList.toggle('error', error); };
  const mutate = operation => { finishGesture(); undo.push(snapshot()); local.operator=currentOperator(); operation(); dirty = true; persist(); update(); };
  const commitReviewFlag = item => { item.review_status = 'local_revision_pending_review'; item.coordinate_evidence_status = 'modified_pending_review'; };
  function asset(item) { return catalog[item.prototype_id] || null; }
  function assetAnchor(item) {
    const entry=asset(item),crop=entry?.alpha_crop;
    const fraction = item.native_support_override&&crop?[(item.native_support_override[0]-crop[0])/(crop[2]-crop[0]),(item.native_support_override[1]-crop[1])/(crop[3]-crop[1])]:entry?.anchor_fraction || [.5, 1];
    return [item.mirror_x ? 1 - fraction[0] : fraction[0], fraction[1]];
  }
  function updateDeliveryAnchor(item) {
    item.delivery_anchor = item.source_anchor.map((value, axis) => value * (targetSize()[axis] / sourceSize()[axis]));
  }
  function recomputeBox(item, fromSource = false) {
    let width, height;
    if (uniformSizes()) {
      const standard=standardSize(item);if(!standard)throw new Error(`原型 ${item.prototype_id} 缺少统一尺寸政策，不能退回逐实例尺寸。`);
      const percent=standard.scale_percent??100;item.local_baseline_size=[standard.width,standard.height];item.local_scale_percent=percent;width=standard.width*percent/100;height=standard.height*percent/100;
    } else if (fromSource) {
      const rawW = (item.source_bbox[2] - item.source_bbox[0]) / sourceSize()[0] * targetSize()[0];
      const rawH = (item.source_bbox[3] - item.source_bbox[1]) / sourceSize()[1] * targetSize()[1];
      const entry = asset(item), img = pictures[item.prototype_id], crop = entry?.alpha_crop;
      const aspect = crop ? (crop[2]-crop[0])/(crop[3]-crop[1]) : img ? img.naturalWidth/img.naturalHeight : rawW/rawH;
      if (item.source_bbox_fit_axis==='width'||(item.source_clipped_edges || []).includes('top')||['facility-04','facility-05'].includes(item.prototype_id)) {width=rawW;height=width/aspect;}
      else {height=rawH;width=height*aspect;}
      item.local_baseline_size = [width,height]; item.local_scale_percent = 100;
    } else {
      const base = item.local_baseline_size || [item.render_bbox[2]-item.render_bbox[0],item.render_bbox[3]-item.render_bbox[1]];
      item.local_baseline_size = base;
      const ratio = (item.local_scale_percent || 100) / 100;
      width = base[0] * ratio; height = base[1] * ratio;
    }
    const [u,v] = assetAnchor(item), [x,y] = item.delivery_anchor;
    item.render_bbox = [x-u*width,y-v*height,x+(1-u)*width,y+(1-v)*height];
  }
  function bounds(which) {
    const result = which === 'source' ? coords()?.source_bounds : coords()?.delivery_bounds;
    return result || (which === 'source' ? [0,0,...sourceSize()] : [0,0,...targetSize()]);
  }
  function transform(which) {
    const [x0,y0,x1,y1] = bounds(which), canvas = which === 'source' ? sourceCanvas : renderCanvas;
    return {x:x=> (x-x0)/(x1-x0)*canvas.width,y:y=> (y-y0)/(y1-y0)*canvas.height,sx:canvas.width/(x1-x0),sy:canvas.height/(y1-y0)};
  }
  function setZoom(percent,focus=false) {
    const zoom=Math.max(100,Math.min(300,Number(percent)||100));$('zoomSelect').value=String(zoom);
    for(const [which,canvas,id]of [['source',sourceCanvas,'sourceScroll'],['render',renderCanvas,'renderScroll']]){
      canvas.style.width=zoom+'%';const pane=$(id),item=selected();
      if(focus&&item){const b=bounds(which),box=which==='source'?item.source_bbox:item.render_bbox;pane.scrollLeft=((box[0]+box[2])/2-b[0])/(b[2]-b[0])*pane.scrollWidth-pane.clientWidth/2;pane.scrollTop=((box[1]+box[3])/2-b[1])/(b[3]-b[1])*pane.scrollHeight-pane.clientHeight/2;}
      else {pane.scrollLeft=0;pane.scrollTop=0;}
    }
  }
  function drawBackground(ctx, which, picture) {
    const [x0,y0,x1,y1] = bounds(which), dimensions = which === 'source' ? sourceSize() : targetSize();
    ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height); ctx.fillStyle='#e6dcc7'; ctx.fillRect(0,0,ctx.canvas.width,ctx.canvas.height);
    if (picture) ctx.drawImage(picture,x0/dimensions[0]*picture.naturalWidth,y0/dimensions[1]*picture.naturalHeight,(x1-x0)/dimensions[0]*picture.naturalWidth,(y1-y0)/dimensions[1]*picture.naturalHeight,0,0,ctx.canvas.width,ctx.canvas.height);
    if ($('showMask').checked && pictures.mask) {
      const mask=pictures.mask; ctx.save(); ctx.globalAlpha=.23;
      ctx.drawImage(mask,x0/dimensions[0]*mask.naturalWidth,y0/dimensions[1]*mask.naturalHeight,(x1-x0)/dimensions[0]*mask.naturalWidth,(y1-y0)/dimensions[1]*mask.naturalHeight,0,0,ctx.canvas.width,ctx.canvas.height);ctx.restore();
    }
  }
  function drawSprite(ctx, item) {
    // Aggregate provenance is not another physical prop over its children.
    if (item.observation_semantics==='group' && item.child_ids?.length) return;
    const t=transform('render'), b=item.render_bbox, img=pictures[item.prototype_id], entry=asset(item);
    const x=t.x(b[0]),y=t.y(b[1]),w=(b[2]-b[0])*t.sx,h=(b[3]-b[1])*t.sy;
    if (!img || !entry || typeof item.mirror_x!=='boolean'||item.observation_semantics==='group') {
      if ($('showBoxes').checked) {ctx.save();ctx.strokeStyle='#ae603a';ctx.setLineDash([10,7]);ctx.lineWidth=2;ctx.strokeRect(x,y,w,h);ctx.restore();}return;
    }
    const crop=entry.alpha_crop || [0,0,img.naturalWidth,img.naturalHeight];
    ctx.save(); if (item.mirror_x) {ctx.translate(x+w,y);ctx.scale(-1,1);} else ctx.translate(x,y);
    ctx.drawImage(img,crop[0],crop[1],crop[2]-crop[0],crop[3]-crop[1],0,0,w,h);ctx.restore();
  }
  function drawGrid(ctx, which) {
    if (!$('showGrid').checked) return;
    const b=bounds(which),t=transform(which),step=which==='source'?100:512;
    ctx.save();ctx.lineWidth=1;ctx.strokeStyle='#faf8ed77';ctx.fillStyle='#324c3d';ctx.font='17px "Microsoft YaHei", sans-serif';
    for(let x=Math.ceil(b[0]/step)*step;x<b[2];x+=step){ctx.beginPath();ctx.moveTo(t.x(x),0);ctx.lineTo(t.x(x),ctx.canvas.height);ctx.stroke();ctx.fillText(String(x),t.x(x)+4,20);}
    for(let y=Math.ceil(b[1]/step)*step;y<b[3];y+=step){ctx.beginPath();ctx.moveTo(0,t.y(y));ctx.lineTo(ctx.canvas.width,t.y(y));ctx.stroke();if(y!==b[1])ctx.fillText(String(y),4,t.y(y)+20);}
    ctx.restore();
  }
  function drawAnnotations(ctx,which) {
    const t=transform(which);
    for (const item of currentInstances()) {
      const chosen=item.instance_id===selectedId,b=which==='source'?item.source_bbox:item.render_bbox,a=which==='source'?item.source_anchor:item.delivery_anchor;
      const color=chosen?'#fbe35b':item.match_status==='pending_asset'?'#bc4c38':item.match_status==='art_variant_substitution'?'#ce872b':'#3e7861';
      ctx.save();ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=chosen?5:3;
      if ($('showBoxes').checked || chosen) {
        const x=t.x(b[0]),y=t.y(b[1]),w=(b[2]-b[0])*t.sx,h=(b[3]-b[1])*t.sy;
        ctx.strokeRect(x,y,w,h);const text=item.instance_id.replace(/^.*?r\d+c\d+[-_]?/,'');
        ctx.font='bold 18px "Microsoft YaHei", sans-serif';const textW=ctx.measureText(text).width;const ty=Math.max(24,y);
        ctx.fillRect(Math.max(0,x),ty-24,textW+12,26);ctx.fillStyle='#263d31';ctx.fillText(text,Math.max(0,x)+6,ty-5);
      }
      if ($('showAnchors').checked || chosen) {ctx.strokeStyle='#fcf9ee';ctx.fillStyle=color;const x=t.x(a[0]),y=t.y(a[1]);ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.beginPath();ctx.moveTo(x-15,y);ctx.lineTo(x+15,y);ctx.moveTo(x,y-15);ctx.lineTo(x,y+15);ctx.stroke();}
      ctx.restore();
    }
  }
  function draw() {
    if (!model || !regionId) return;
    drawBackground(sourceCtx,'source',pictures.source);drawBackground(renderCtx,'render',pictures.clean);
    // Draw intersecting neighbors too: foot ownership controls counts/editing,
    // not which side of a tile boundary a roof may project into.
    const tile=bounds('render');
    model.instances.filter(i=>{const b=i.render_bbox;return b[0]<tile[2]&&b[2]>tile[0]&&b[1]<tile[3]&&b[3]>tile[1];})
      .sort((a,b)=>(a.render_order||0)-(b.render_order||0)).forEach(item=>drawSprite(renderCtx,item));
    const b=bounds('render'),dimensions=targetSize();
    for(const layer of model.visual_foreground_layers||[]){
      const img=pictures[layer.id];if(img)renderCtx.drawImage(img,b[0]/dimensions[0]*img.naturalWidth,b[1]/dimensions[1]*img.naturalHeight,(b[2]-b[0])/dimensions[0]*img.naturalWidth,(b[3]-b[1])/dimensions[1]*img.naturalHeight,0,0,renderCanvas.width,renderCanvas.height);
    }
    drawGrid(sourceCtx,'source');drawGrid(renderCtx,'render');drawAnnotations(sourceCtx,'source');drawAnnotations(renderCtx,'render');
  }
  function updateInspector() {
    const item=selected(),uniform=uniformSizes(),blocked=item&&uniform?blockedPrototypeMembers(item):[];
    $('coordinateFields').disabled=!item||uniform||frozen()||!!item?.source_primitive||!!item?.source_support_dependents?.length;$('scaleFields').disabled=!item||!frozen()||!!item?.source_primitive||!!blocked.length;
    $('scaleLegend').textContent=uniform?'同类统一尺寸 · 跨分区已有与补充实例联动':'冻结后 · 只改选中单件的大小';
    $('scaleHint').textContent=uniform?'100% 是本政策的标准主体尺寸；拖动会调整全图同一原型的所有已有与补充实例。身份、方向、锚点不变，不新增实例。':'100% 是本次坐标冻结时的尺寸。拖动实时预览，锚点不动；不自动补量。';
    $('scaleRange').setAttribute?.('aria-label',uniform?'同类统一缩放':'单件缩放');$('scaleNumber').setAttribute?.('aria-label',uniform?'同类统一缩放百分比':'单件缩放百分比');
    if(!item){$('selectedName').textContent='本块尚无观察实例';$('selectedMeta').textContent='先完成原图标注，不能冻结空白分区。';$('measurements').textContent='';$('objectNotes').textContent='';return;}
    const entry=asset(item), b=item.source_bbox, r=item.render_bbox;
    $('selectedName').textContent=item.display_name||item.instance_id;
    $('selectedMeta').innerHTML=`<b>${escapeHtml(item.instance_id)}</b><br>原型：${escapeHtml(item.prototype_id||'待确定')} · ${escapeHtml(entry?.name||'缺少素材')}<br>匹配：${escapeHtml(label(item.match_status))}<br>素材方向：${typeof item.mirror_x!=='boolean'?'朝向待确定':item.mirror_x?'水平翻转':'保持素材原始方向'}<br>测量不确定度：±${fmt(item.uncertainty_source_px||0)} 原图 px${item.render_visibility?`<br>当前轮廓可见 ${fmt(item.render_visibility.visible_fraction*100)}%${visibilityBlocked(item)?' · 关键轮廓被挡，需修订':''}`:''}`;
    [b[0],b[1],b[2],b[3],...item.source_anchor].forEach((value,i)=>{if(document.activeElement!==$(ids[i]))$(ids[i]).value=value;});
    $('mirrorX').checked=!!item.mirror_x;
    const standard=uniform?standardSize(item):null,pct=standard?.scale_percent||item.local_scale_percent||100;$('scaleRange').value=pct;if(document.activeElement!==$('scaleNumber'))$('scaleNumber').value=pct;
    const sw=b[2]-b[0],sh=b[3]-b[1],dw=r[2]-r[0],dh=r[3]-r[1];
    const overflow=r[0]<0||r[1]<0||r[2]>targetSize()[0]||r[3]>targetSize()[1];
    const bodyHeight=standard?.body_height_delivery??standard?.body_reference?.delivery_height??standard?.body_reference?.body_height_delivery;
    $('measurements').innerHTML=`原图框：${fmt(sw)} × ${fmt(sh)} px<br>占整图宽/高：${fmt(sw/sourceSize()[0]*100)}% / ${fmt(sh/sourceSize()[1]*100)}%<br>原图锚点：(${item.source_anchor.map(fmt).join(', ')})<br>4096 锚点：(${item.delivery_anchor.map(fmt).join(', ')})<br>${uniform?'4096 同类标准完整主体':'复原有效内容'}：${fmt(dw)} × ${fmt(dh)} px${uniform?`<br>全图同类联动：${samePrototype(item).length} 件 · 标准 ${fmt(standard.width)} × ${fmt(standard.height)} px${bodyHeight?`<br>角色身体标尺：${fmt(bodyHeight*pct/100)} px（帽具保留各自完整比例）`:''}`:''}${overflow?'<br><span class="error">当前素材超出整图边界，待修正。</span>':''}${blocked.length?'<br><span class="error">本原型包含固定屋顶承载子件，禁止只调整父级大小。</span>':''}`;
    $('objectNotes').textContent=(Array.isArray(item.notes)?item.notes.join('；'):(item.notes||''))+(item.review_status==='local_revision_pending_review'?'；本地修改待复核。':'')+(item.source_primitive?'；此结构按逐柱脚、逐段端点复原；不能用整体框缩放或镜像改变实际坐标。':'')+(blocked.length?`；全类限制涉及 ${blocked.map(row=>row.instance_id).join('、')}，不挪动其固定屋顶子件锚点。`:item.source_support_dependents?.length?'；此对象承载固定坐标的子件；几何变化需要单独建立承载修订。':'')+(item.source_shape_conflict?'；替代建筑的台阶或立柱占了原图位置；需要修正素材轮廓，不能靠把对象画在最前面冒充落地。':'');
  }
  function update() {
    const list=currentInstances(),r=region(),isPending=!list.length||r?.status==='pending';
    $('phaseTitle').textContent=uniformSizes()?'数量受限标准件测试 · 同原型统一尺寸':frozen()?'阶段 1 已冻结 · 可只改大小预留空间':'阶段 1 · 复原原图已有元素';
    $('standardPolicyBanner').hidden=!uniformSizes();
    $('policyStatus').textContent=uniformSizes()?`政策 ${sizePolicy().revision}；全图同原型共享4096标准尺寸，原图锚点、交付锚点、身份与方向均不可修改。当前 ${model.instances.length} 件为表内标准件测试；完整观察库中的排除项及数量冲突尚未解决，未正式交付。${cacheRejected?' 已拒绝旧版逐实例或尺寸不一致缓存，使用本候选标准几何。':''}`:'';
    $('phaseBadge').textContent=isPending?'尚未标注':frozen()?scopeName()+'坐标已本地冻结':'原图观察待复核';$('phaseBadge').classList.toggle('pending',!frozen());
    const supplemental=model.instances.filter(i=>i.placement_source==='supplemental'||i.is_supplemental).length;
    $('scopeInfo').textContent=uniformSizes()?`当前表内标准实例 ${model.instances.length} 件；其中补充 ${supplemental} 件。${scopeName()}${categoryName[category]} ${list.length} 件。完整原图观察和未采纳冲突另列，标准件数量不等于观察总数。`:`当前数据共记录 ${model.instances.length} 条原图观察；补量 ${supplemental}。${scopeName()}${categoryName[category]} ${list.length} 条。组合记录不能直接当成玩法实例数量。`;
    const unannotated=model.regions.filter(entry=>entry.status==='pending').length;
    $('scopeWarning').textContent=`${unannotated?`仍有 ${unannotated} 个分块尚未标注；`:''}${manifest.categories?.length>1?'各类源观察已接入；未映射结构、连续组合与数量冲突仍待处理。':'本轮仅覆盖建筑观察，其他类别尚未接入。'}剩余数量补齐尚未验收；坐标冻结只覆盖当前查看范围与类别。${assetLoadErrors.length?` ${assetLoadErrors.length} 种素材加载失败，相关范围不能冻结。`:''}`;
    $('regionCounts').textContent=`${scopeName()} ${list.length} 条观察 · 组合父记录 ${list.filter(i=>i.observation_semantics==='group').length} · 素材匹配 ${list.filter(i=>i.match_status==='matched').length} · 外观替代 ${list.filter(i=>i.match_status==='art_variant_substitution').length} · 缺素材 ${list.filter(i=>i.match_status==='pending_asset').length}；观察记录不等于玩法件数`;
    $('regionNotice').textContent=isPending?`${r?.name||regionId} 当前类别没有已记录对象，不能由此推断整块或其他类别已经完成。`:`${r?.name||regionId} · ${categoryName[category]}。${uniformSizes()?'锚点、身份与方向保持候选数据；尺寸滑条按同一原型跨全图统一联动。':frozen()?'脚底锚点和方向已锁定；当前只能缩放选中单件。':'先核对原图框、锚点与方向。修正会更新4096换算，并标为待复核。'}`;
    $('regionNotice').classList.toggle('pending',isPending);
    $('sourceExtent').textContent=`原图范围 [${bounds('source').map(fmt).join(', ')}] px`;
    $('deliveryExtent').textContent=`交付范围 [${bounds('render').map(fmt).join(', ')}] px`;
    $('objectList').innerHTML=list.map(i=>`<option value="${escapeHtml(i.instance_id)}">${escapeHtml(i.display_name||i.instance_id)} · ${escapeHtml(label(i.match_status))}</option>`).join('');$('objectList').value=selectedId||'';
    $('freeze').disabled=isPending||list.some(i=>!canFreeze(i));$('freeze').textContent='冻结'+scopeName()+'当前类别坐标';$('freeze').hidden=frozen();$('unfreeze').hidden=!frozen();$('undo').disabled=!undo.length;
    $('exportJson').disabled=false;$('exportPng').disabled=false;
    $('reviewInfo').textContent=`交付包复核状态：${manifest.review_status||'待复核'}。${scopeName()}：${local.frozen?'当前操作者已冻结坐标；后续尺寸变化仍待复核。':dirty?'存在本地修改，待复核。':'观察结果待复核。'}`;
    $('revisionInfo').textContent=`数据版本：${manifest.revision}；本地修订 ${local.revision}；历史冻结快照 ${local.freezes.length} 份。当前操作者：${operatorKind}（${currentOperator().label}）。`;
    $('coordinateInfo').textContent=`x4096 = x原图 × ${targetSize()[0]} ÷ ${sourceSize()[0]}；y4096 = y原图 × ${targetSize()[1]} ÷ ${sourceSize()[1]}。使用原始图尺寸，不用屏幕截图的缩放尺寸。`;
    updateInspector();draw();
  }
  function chooseRegion(id,newCategory=category) {
    const previousSelected=selectedId;finishGesture();if(regionId)persist();regionId=id;category=newCategory;undo=[];dirty=false;gesture=null;
    local={revision:1,frozen:false,freezes:[],operator:currentOperator(),created_at:new Date().toISOString()};
    try {const saved=JSON.parse(localStorage.getItem(key())||'null');const validSizeCache=!uniformSizes()||!saved||saved.prototype_size_policy_identity===sizePolicyIdentity&&Array.isArray(saved.instances)&&validateUniformCache(saved.instances,saved.prototype_size_policy);if(saved&&!validSizeCache)cacheRejected=true;if(saved?.manifest_revision===manifest.revision&&saved.region_id===regionId&&Array.isArray(saved.instances)&&saved.local&&validSizeCache){
      local=clone(saved.local);selectedId=saved.selected_id;dirty=true;
      const current=new Map(model.instances.map(item=>[item.instance_id,item]));
      const changed=saved.instances.some(item=>['source_bbox','source_anchor','delivery_anchor','mirror_x'].some(field=>JSON.stringify(item[field])!==JSON.stringify(current.get(item.instance_id)?.[field])));
      if(local.frozen&&changed){local.revision+=1;local.frozen=false;local.parent_freeze_id=local.active_freeze_id;local.active_freeze_id=null;}
    }}
    catch(_){feedback('旧缓存无法读取，已使用原始观察模型。',true);}
    if(currentInstances().some(i=>i.instance_id===previousSelected))selectedId=previousSelected;
    selectedId=currentInstances().some(i=>i.instance_id===selectedId)?selectedId:currentInstances()[0]?.instance_id;
    $('regionSelect').value=regionId;$('categorySelect').value=category;update();setZoom(100);feedback(cacheRejected?'已拒绝不符合统一尺寸政策的旧缓存；当前使用本候选标准几何。':frozen()?'已载入'+scopeName()+'当前类别的本地冻结修订。':'点击图中物件即可核对；可放大选中物件查看细节。');
  }
  function editCoordinates() {
    const item=selected();if(!item)return;if(uniformSizes()){updateInspector();feedback('数量受限标准件测试仅允许同类统一尺寸；原图锚点、交付锚点、身份与方向保持不变。',true);return;}if(frozen())return;
    if(item.source_primitive||item.source_support_dependents?.length){updateInspector();feedback('逐点结构或承载对象需要专门的结构修订，不能仅修改整体框和锚点。',true);return;}
    const values=ids.map(id=>Number($(id).value));
    if(values.some(value=>!Number.isFinite(value))||values[0]<0||values[1]<0||values[2]>sourceSize()[0]||values[3]>sourceSize()[1]||values[0]>=values[2]||values[1]>=values[3]||values[4]<0||values[4]>sourceSize()[0]||values[5]<0||values[5]>sourceSize()[1]){feedback('坐标无效：框需在原图范围内，右下大于左上，锚点需在原图内。',true);return;}
    const edge=regionId==='all'?(model.coordinate_model?.regions||[]).find(r=>r.region_id===item.region_id):coords();
    const [rx0,ry0,rx1,ry1]=edge?.source_bounds||bounds('source');
    if(values[4]<rx0||(edge?.right_edge_inclusive?values[4]>rx1:values[4]>=rx1)||values[5]<ry0||(edge?.bottom_edge_inclusive?values[5]>ry1:values[5]>=ry1)){feedback(`锚点必须归属当前分块。不能在本块把对象改到别区；请先在观察模型中建立对应分区修订。`,true);return;}
    const boxChanged=values.slice(0,4).some((value,i)=>value!==item.source_bbox[i]);
    const anchorChanged=values.slice(4,6).some((value,i)=>value!==item.source_anchor[i]);
    mutate(()=>{item.source_bbox=values.slice(0,4);item.source_anchor=values.slice(4,6);if(anchorChanged)updateDeliveryAnchor(item);recomputeBox(item,boxChanged);commitReviewFlag(item);});feedback('已实时换算到4096坐标并更新复原；本次测量修正待复核。');
  }
  function finishGesture() {
    if(!gesture)return;
    if(JSON.stringify(gesture.instances)!==JSON.stringify((uniformSizes()?model.instances:currentInstances()).map(geometry)))undo.push(gesture);
    gesture=null;persist();$('undo').disabled=!undo.length;
  }
  function liveScale(event) {
    const item=selected();if(!item||!frozen())return;
    if(item.source_primitive){updateInspector();feedback('此结构使用逐点原图坐标，不能整体缩放。',true);return;}
    const blockers=uniformSizes()?blockedPrototypeMembers(item):item.source_support_dependents?.length?[item]:[];
    if(blockers.length){updateInspector();feedback(`同类存在承载已有设施的父级（${blockers.map(row=>row.instance_id).join('、')}）；禁止单独缩放父原型，固定屋顶子件锚点不会被移动。请保持本政策标准尺寸，另行复核承载关系。`,true);return;}
    const raw=Number(event.target.value);if(!Number.isFinite(raw))return;
    if(!gesture)gesture=snapshot();
    const percent=Math.max(25,Math.min(200,Math.round(raw)));
    local.operator=currentOperator();
    if(uniformSizes()) {
      standardSize(item).scale_percent=percent;
      const rows=samePrototype(item);rows.forEach(row=>{recomputeBox(row);commitReviewFlag(row);});
      sizePolicy().last_change={prototype_id:item.prototype_id,scale_percent:percent,scope:'all_instances',affected_instance_ids:rows.map(row=>row.instance_id),operator:currentOperator(),changed_at:new Date().toISOString(),anchors_preserved:true,adds_instances:false};
    } else {item.local_scale_percent=percent;recomputeBox(item);commitReviewFlag(item);}
    dirty=true;
    $('scaleRange').value=item.local_scale_percent;if(event.target!==$('scaleNumber'))$('scaleNumber').value=item.local_scale_percent;
    persist();updateInspector();draw();feedback(uniformSizes()?`已将 ${item.prototype_id} 全图 ${samePrototype(item).length} 件统一缩放至 ${percent}%（含已有与补充）；所有锚点、身份与方向不变，实例数不变。`:`已将选中单件缩放至 ${item.local_scale_percent}%；锚点与镜向保持冻结。`);
  }
  function selectAt(event,which) {
    finishGesture();const canvas=which==='source'?sourceCanvas:renderCanvas,rect=canvas.getBoundingClientRect(),b=bounds(which);
    const x=b[0]+(event.clientX-rect.left)/rect.width*(b[2]-b[0]),y=b[1]+(event.clientY-rect.top)/rect.height*(b[3]-b[1]);
    const hit=currentInstances().filter(i=>!(i.observation_semantics==='group'&&i.child_ids?.length)).sort((a,b)=>(b.render_order||0)-(a.render_order||0)).find(i=>{const r=which==='source'?i.source_bbox:i.render_bbox;return x>=r[0]&&x<=r[2]&&y>=r[1]&&y<=r[3];});
    if(hit){selectedId=hit.instance_id;persist();update();}
  }
  function download(blob,name) {const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function exportModel() {
    finishGesture();const result=clone(model);result.local_review={schema:'source-reconstruction-review.v1',source_revision:manifest.revision,exported_at:new Date().toISOString(),operator:currentOperator(),scope:reviewScope(),region_id:regionId,category,coordinate_freeze:clone(local),formal_acceptance:false,supplemental_enabled:false,...(uniformSizes()?{size_scope:'all_instances_by_prototype',delivery_status:'quantity_limited_standard_asset_test_observation_conflicts_unresolved'}:{}),notes:['本地确认不等于正式全图验收。',uniformSizes()?'坐标复核只覆盖当前范围；尺寸修改统一作用于全图同原型已有与补充实例，不改变数量。':'只覆盖当前查看范围和类别，未确认对象仍然待复核。']};
    download(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}),`${manifest.revision}-${regionId}-local-r${local.revision}.json`);feedback('已导出完整观察模型和'+scopeName()+'冻结记录；未确认对象仍然待复核。');
  }
  async function exportComparison() {
    const previews={...pictures};
    try {
      const pairs=await Promise.all([loadImage(manifest.source_image).then(image=>['source',image]),loadImage(manifest.clean_image).then(image=>['clean',image]),...Object.entries(catalog).filter(([,entry])=>entry?.src).map(async([id,entry])=>[id,await loadImage(entry.src)])]);
      Object.assign(pictures,Object.fromEntries(pairs));draw();
    } catch(error) {Object.assign(pictures,previews);feedback('原始素材读取失败：'+error.message,true);return;}

    finishGesture();const canvas=document.createElement('canvas');canvas.width=sourceCanvas.width*2+40;canvas.height=sourceCanvas.height+140;const ctx=canvas.getContext('2d');ctx.fillStyle='#f8f6ef';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#303c34';ctx.font='bold 24px "Microsoft YaHei", sans-serif';ctx.fillText(`${manifest.name||'大峡谷'} · ${scopeName()} · ${uniformSizes()?'数量受限标准件测试':'原图标注 / 素材复原'}`,20,35);ctx.font='16px "Microsoft YaHei", sans-serif';ctx.fillText(`版本 ${manifest.revision} · 本地修订 ${local.revision} · ${frozen()?scopeName()+'坐标本地冻结':'待复核'} · 补充 ${model.instances.filter(item=>item.is_supplemental||item.placement_source==='supplemental').length}`,20,68);ctx.drawImage(sourceCanvas,10,90);ctx.drawImage(renderCanvas,sourceCanvas.width+30,90);ctx.fillText(uniformSizes()?'观察冲突未解决；未正式交付。同原型标准尺寸联动，所有锚点与数量保持。':'此图展示当前查看范围；未确认对象仍然待复核。',20,canvas.height-18);canvas.toBlob(blob=>{if(blob)download(blob,`${manifest.revision}-${regionId}-comparison.png`);else feedback('导出图片失败，请保留 JSON。',true);});
    Object.assign(pictures,previews);draw();
  }
  async function loadImage(url) {return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error(`图片无法读取：${url}`));image.src=url;});}
  async function loadJson(url) {const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error(`无法读取 ${url}（${response.status}）`);return response.json();}
  async function init() {
    try {
      manifest=await loadJson('manifest.json');[model,catalog]=await Promise.all([loadJson(manifest.model||'model.json'),loadJson(manifest.catalog||'catalog.json')]);catalog=catalog.prototypes||catalog.assets||catalog;
      category='all';
      if(!Array.isArray(model.instances)||!Array.isArray(model.regions)||!manifest.source_size||!manifest.canvas)throw new Error('模型缺少 instances / regions / 原图或画布尺寸。');
      const imageResults=await Promise.allSettled([loadImage(manifest.source_preview||manifest.source_image),loadImage(manifest.clean_preview||manifest.clean_image),manifest.mask_image?loadImage(manifest.mask_image):Promise.resolve(null)]);
      ['source','clean','mask'].forEach((name,i)=>{pictures[name]=imageResults[i].status==='fulfilled'?imageResults[i].value:null;});
      if(!pictures.source||!pictures.clean)throw new Error('原图或干净底图无法加载，不能进行对齐复核。');
      const entries=Object.entries(catalog).filter(([,entry])=>entry?.src);
      const results=await Promise.allSettled(entries.map(([,entry])=>loadImage(entry.preview_src||entry.src)));results.forEach((result,i)=>{if(result.status==='fulfilled')pictures[entries[i][0]]=result.value;else assetLoadErrors.push(entries[i][0]);});
      const foreground=model.visual_foreground_layers||[];
      const foregroundResults=await Promise.allSettled(foreground.map(layer=>loadImage(layer.src)));
      foregroundResults.forEach((result,i)=>{if(result.status==='fulfilled')pictures[foreground[i].id]=result.value;else assetLoadErrors.push(foreground[i].id);});
      if(sizePolicy()&&!uniformSizes())throw new Error(`不支持的标准尺寸政策 ${sizePolicy().mode}，不能退回逐实例缩放。`);
      if(uniformSizes()) {
        const policy=sizePolicy();if(!policy.revision||!policy.sizes||policy.coordinate_space!=='delivery'||policy.scope!=='all_instances')throw new Error('统一尺寸政策缺少 revision / sizes / delivery / all_instances 字段。');
        sizePolicyIdentity=policyIdentity(policy);
        model.instances.forEach(item=>{const standard=standardSize(item);if(!standard||![standard.width,standard.height].every(value=>Number.isFinite(value)&&value>0))throw new Error(`原型 ${item.prototype_id} 没有有效标准尺寸。`);item.local_scale_percent=standard.scale_percent??100;item.local_baseline_size=[standard.width,standard.height];});
        if(!validateUniformCache(model.instances,policy))throw new Error('候选几何不符合标准尺寸政策，禁止进入逐实例降级模式。');
      } else model.instances.forEach(item=>{item.local_scale_percent=100;item.local_baseline_size=[item.render_bbox[2]-item.render_bbox[0],item.render_bbox[3]-item.render_bbox[1]];});
      hydrateGeometry();
      $('pageTitle').textContent=manifest.name||'大峡谷 · 原图优先复原';
      $('regionSelect').innerHTML='<option value="all">全图对照</option>'+model.regions.map(r=>`<option value="${escapeHtml(r.region_id)}">${escapeHtml(r.name||r.region_id)} · ${r.status==='pending'?'尚未标注':label(r.status)}</option>`).join('');
      chooseRegion('all');
      $('zoomSelect').addEventListener('change',event=>setZoom(event.target.value));
      $('focusObject').addEventListener('click',()=>setZoom(300,true));$('fitView').addEventListener('click',()=>setZoom(100));
      for(const [id,otherId]of [['sourceScroll','renderScroll'],['renderScroll','sourceScroll']])$(id).addEventListener('scroll',()=>{const pane=$(id),other=$(otherId);if(Math.abs(other.scrollLeft-pane.scrollLeft)>1)other.scrollLeft=pane.scrollLeft;if(Math.abs(other.scrollTop-pane.scrollTop)>1)other.scrollTop=pane.scrollTop;});
      $('regionSelect').addEventListener('change',event=>chooseRegion(event.target.value));
      $('categorySelect').addEventListener('change',event=>chooseRegion(regionId,event.target.value));
      ['showBoxes','showAnchors','showMask','showGrid'].forEach(id=>$(id).addEventListener('change',draw));
      $('objectList').addEventListener('change',event=>{finishGesture();selectedId=event.target.value;persist();update();});
      ids.forEach(id=>$(id).addEventListener('change',editCoordinates));
      $('mirrorX').addEventListener('change',()=>{const item=selected();if(!item)return;if(uniformSizes()){updateInspector();feedback('标准件尺寸测试不改变镜向，保持原图记录的左右方向。',true);return;}if(frozen())return;if(item.source_primitive||item.source_support_dependents?.length){updateInspector();feedback('逐点结构或承载对象不能单独镜像。',true);return;}mutate(()=>{item.mirror_x=$('mirrorX').checked;recomputeBox(item);commitReviewFlag(item);});feedback('已调整素材镜向；原图锚点未改变，方向需复核。');});
      ['scaleRange','scaleNumber'].forEach(id=>{$(id).addEventListener('input',liveScale);$(id).addEventListener('change',()=>{finishGesture();update();});});
      $('undo').addEventListener('click',()=>{finishGesture();if(!undo.length)return;restore(undo.pop());dirty=true;persist();update();feedback('已撤销一次几何修改；冻结状态不跨版本回退。');});
      $('freeze').addEventListener('click',()=>{
        finishGesture();if(!currentInstances().length||currentInstances().some(i=>!canFreeze(i))){feedback('当前范围没有对象，或仍有缺素材、未知朝向、组合语义未定、关键轮廓被遮挡，不能据此冻结复原结果。',true);return;}
        if(!uniformSizes())currentInstances().forEach(item=>{item.anchor_locked=true;item.local_baseline_size=[item.render_bbox[2]-item.render_bbox[0],item.render_bbox[3]-item.render_bbox[1]];item.local_scale_percent=100;});
        local.operator=currentOperator();const record={freeze_id:`${manifest.revision}:${regionId}:${operatorKind}-${local.revision}:${Date.now()}`,created_at:new Date().toISOString(),operator:clone(currentOperator()),scope:reviewScope(),region_id:regionId,category,formal_acceptance:false,instances:clone(currentInstances().map(geometry)),...(uniformSizes()?{prototype_size_policy_revision:sizePolicy().revision,size_scope:'all_instances_by_prototype'}:{})};local.freezes.push(record);local.frozen=true;local.active_freeze_id=record.freeze_id;undo=[];dirty=true;persist();update();feedback(uniformSizes()?'已保存当前范围坐标复核快照。后续尺寸修改按原型跨全图联动，不改变任何锚点。':'已保存'+scopeName()+'当前类别的坐标快照。原图框、锚点和镜向锁定；可只调整选中单件大小。');
      });
      $('unfreeze').addEventListener('click',()=>{finishGesture();local.operator=currentOperator();local.revision+=1;local.frozen=false;local.parent_freeze_id=local.active_freeze_id;local.active_freeze_id=null;local.created_at=new Date().toISOString();if(!uniformSizes())currentInstances().forEach(item=>{item.anchor_locked=false;commitReviewFlag(item);});undo=[];dirty=true;persist();update();feedback(`已建立本地修订 ${local.revision}，旧冻结快照完整保留；${uniformSizes()?'本标准件测试的锚点和方向继续锁定。':'本轮坐标变更需重新复核。'}`);});
      $('exportJson').addEventListener('click',exportModel);$('exportPng').addEventListener('click',exportComparison);sourceCanvas.addEventListener('click',event=>selectAt(event,'source'));renderCanvas.addEventListener('click',event=>selectAt(event,'render'));
      window.addEventListener('beforeunload',()=>{finishGesture();persist();});
      window.reconstructionPilot={getModel:()=>clone(model),getRegion:()=>regionId,getLocalReview:()=>clone(local),getManifest:()=>clone(manifest)};
    } catch(error) {feedback(`加载失败：${error.message}`,true);$('scopeInfo').textContent='数据未加载，不能将此页视为已完成复原。';console.error(error);}
  }
  init();
})();
