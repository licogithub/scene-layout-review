/* GitHub Pages transport. No plugin simulation, remote writes or shared draft. */
(() => {
  'use strict';
  const clone=x=>JSON.parse(JSON.stringify(x));
  const key='tmc-shared-manual-layout-v1';let state;
  function mark(){state.revision++;state.state_hash=`shared-${state.revision}-${Date.now()}`;state.validation={status:'stale',message:'在线编辑未运行真实插件检验。'};state.supplemental_stale=true;}
  function rebuild(){
    const anchors=state.plan.source_instance_anchors;
    for(const model of [state.base_model,state.active_model])for(const item of model.instances){
      if(anchors[item.instance_id])item.delivery_anchor=clone(anchors[item.instance_id]);
      const asset=state.catalog[item.prototype_id],size=state.prototype_size_policy.sizes[item.prototype_id],c=asset.alpha_crop;
      let [u,v]=item.native_support_override?[(item.native_support_override[0]-c[0])/(c[2]-c[0]),(item.native_support_override[1]-c[1])/(c[3]-c[1])]:asset.anchor_fraction;
      if(item.mirror_x)u=1-u;
      const f=(state.plan.category_factors[item.category]??1)*(state.plan.prototype_factors[item.prototype_id]??1),w=size.width*f,h=size.height*f,[x,y]=item.delivery_anchor;
      item.render_bbox=[x-u*w,y-v*h,x+(1-u)*w,y+(1-v)*h];
    }
  }
  async function init(){
    const response=await fetch('state.json',{cache:'no-store'});if(!response.ok)throw new Error('共享布局数据加载失败。');
    state=await response.json();
    try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved?.baseline===state.prototype_size_policy.revision&&saved?.published===state.publication_revision){state=clone(saved.state);}}catch{}
    state.runtime_mode='shared-static';state.job=null;state.token='';
  }
  const ready=init();
  window.manualLayoutTransport={async request(path,body){
    await ready;
    if(path==='/state')return clone(state);
    if(body?.revision!==state.revision)throw new Error('本浏览器草稿版本已变化，请刷新。');
    if(path==='/save'){
      const next=clone(state),move=body.moves||{},byId=new Map(next.base_model.instances.map(item=>[item.instance_id,item]));
      if(Object.keys(move).length&&state.phase!=='base')throw new Error('补量阶段基础坐标锁定。');
      for(const [id,a]of Object.entries(move)){if(byId.get(id)?.category!=='building'||!Array.isArray(a)||a.length!==2||a.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>4096))throw new Error('建筑坐标不合法。');next.plan.source_instance_anchors[id]=clone(a);}
      for(const [kind,values]of [['category_factors',body.category_factors||{}],['prototype_factors',body.prototype_factors||{}]])for(const [id,v]of Object.entries(values)){
        const known=kind==='category_factors'?['building','facility','character'].includes(id):!!next.catalog[id];
        if(!known||typeof v!=='number'||!Number.isFinite(v)||v<.25||v>2)throw new Error('原型或倍率不合法。');next.plan[kind][id]=v;
      }
      state=next;mark();rebuild();
    }else if(path==='/reopen'){state.phase='base';mark();}
    else throw new Error('GitHub Pages不运行真实插件。请导出调整JSON，在本机运行补量与检验。');
    const saved={baseline:state.prototype_size_policy.revision,published:state.publication_revision,state};
    localStorage.setItem(key,JSON.stringify(saved));return clone(state);
  }};
})();
