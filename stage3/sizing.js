'use strict';
// Pure geometry used by the preview and exercised against the real layouts.
globalThis.Stage3Sizing=(()=>{
 const round=v=>Math.round(v*1000)/1000;
 function baselines(layout){return Object.fromEntries(layout.instances.map(r=>[r.instance_id,[r.bbox[2]-r.bbox[0],r.bbox[3]-r.bbox[1]]]))}
 function resizeKind(layout,prototype,percent,baseSizes,{lockBuildings=true,canvas=4096}={}){
  if(!Number.isFinite(percent)||percent<25||percent>200)throw Error('请输入 25–200 之间的缩放百分比。');
  const affected=layout.instances.filter(r=>r.prototype_id===prototype);
  if(!affected.length)throw Error('当前布局中没有这一种类。');
  if(lockBuildings&&affected.some(r=>r.category==='building'))throw Error('请先取消「锁定建筑」，再调整建筑尺寸。');
  const next=structuredClone(layout),byId=new Map(next.instances.map(r=>[r.instance_id,r])),changed=new Set(),scaled=new Map();
  for(const source of affected){
   const row=byId.get(source.instance_id),base=baseSizes[row.instance_id];
   if(!base||base.some(v=>!Number.isFinite(v)||v<=0))throw Error('缺少原始尺寸，请重新载入布局。');
   const [x,y,x1,y1]=source.bbox,[ax,ay]=source.foot_anchor;
   const w=Math.max(1,Math.round(base[0]*percent/100)),h=Math.max(1,Math.round(base[1]*percent/100));
   const sx=w/(x1-x),sy=h/(y1-y),nx=round(ax-(ax-x)*sx),ny=round(ay-(ay-y)*sy);
   row.bbox=[nx,ny,round(nx+w),round(ny+h)];
   if(row.bbox.some((v,i)=>Math.abs(v-source.bbox[i])>0.0001)){changed.add(row.instance_id);scaled.set(row.instance_id,[sx,sy]);}
  }
  // Preserve the placement of carrier children on a resized building. Their
  // own dimensions change only when their own prototype is the chosen kind.
  const children=new Map();for(const r of next.instances)if(r.parent_instance_id){const list=children.get(r.parent_instance_id)||[];list.push(r);children.set(r.parent_instance_id,list)}
  const originals=new Map(layout.instances.map(r=>[r.instance_id,r]));
  function follow(parent,scale){for(const child of children.get(parent.instance_id)||[]){
   const old=originals.get(child.instance_id),oldParent=originals.get(parent.instance_id);
   const anchor=[round(parent.foot_anchor[0]+(old.foot_anchor[0]-oldParent.foot_anchor[0])*scale[0]),round(parent.foot_anchor[1]+(old.foot_anchor[1]-oldParent.foot_anchor[1])*scale[1])];
   const dx=anchor[0]-child.foot_anchor[0],dy=anchor[1]-child.foot_anchor[1];
   child.bbox=child.bbox.map((v,i)=>round(v+(i%2?dy:dx)));child.foot_anchor=anchor;child.depth_y=round(parent.depth_y+.01);changed.add(child.instance_id);
   follow(child,scaled.get(child.instance_id)||[1,1]);
  }}
  for(const source of affected)if(scaled.has(source.instance_id)&&!source.parent_instance_id)follow(byId.get(source.instance_id),scaled.get(source.instance_id));
  for(const id of changed){const row=byId.get(id),[x,y,x1,y1]=row.bbox;
   if(![x,y,x1,y1].every(Number.isFinite)||x<0||y<0||x1>canvas||y1>canvas||x1<=x||y1<=y)throw Error(id+' 调整后会超出画布，请调小比例。');
   row.manual_adjustment=true;row.geometry_review_required=true;
   if(row.prototype_id===prototype)row.manual_size_percent=percent;
   if(row.transform){row.transform.translation=[x,y];const crop=row.transform.source_crop;row.transform.scale_xy=[(x1-x)/(crop[2]-crop[0]),(y1-y)/(crop[3]-crop[1])];}
  }
  return {layout:next,changed:changed.size,count:affected.length};
 }
 return {baselines,resizeKind};
})();
