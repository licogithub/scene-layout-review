'use strict';
// Diagnostic overlays never alter native PNGs or exported scene art.
const skyProjectionSlope=0.53493361118;
const skyProjectionDraw=draw;
draw=function(){
 skyProjectionDraw();
 $('terrainDescription').textContent='天空浮岛 · 透视修正版 · 16 种 / 201 件 · 原型保留原朝向，地图沿用左右随机规则';
 if(!$('showProjection').checked||!report)return;
 ctx.save();ctx.lineWidth=3;
 for(const [slope,color]of [[skyProjectionSlope,'#d7434b70'],[-skyProjectionSlope,'#397bc870']]){
  ctx.strokeStyle=color;ctx.beginPath();
  for(let y=-4096;y<8192;y+=110){ctx.moveTo(0,y);ctx.lineTo(4096,y+slope*4096);}
  ctx.stroke();
 }
 ctx.restore();
};
$('showProjection').onchange=()=>draw();
$('openAssets').textContent='透视修复对比';
const skyLibrary=$('assetLibrary');
skyLibrary.classList.add('perspective-library');
const skyTools=document.createElement('div');skyTools.className='perspective-tools';
skyTools.innerHTML='<label><input id="artGuides" type="checkbox">透视参考线</label><label><input id="artMirror" type="checkbox">镜像检查修正版</label><label>分类 <select id="artCategory"><option value="all">全部 16 种</option><option value="building">建筑 2 种</option><option value="facility">设施 6 种</option><option value="vehicle">载具 3 种</option><option value="character">角色 5 种</option></select></label><span>参考线倾角 28.14°；检查平行关系，物件保留原图自身朝向。</span>';
skyLibrary.querySelector('.library-heading').after(skyTools);
skyLibrary.querySelector('h2').textContent='天空浮岛 · 透视修复对比';
function skyRenderComparison(){
 const grid=$('assetCards');grid.replaceChildren();
 grid.classList.toggle('guides-visible',$('artGuides').checked);
 grid.classList.toggle('mirror-preview',$('artMirror').checked);
 for(const asset of DATA.sourceAssets){
  if($('artCategory').value!=='all'&&!asset.id.startsWith($('artCategory').value+'-'))continue;
  const card=document.createElement('article');card.className='perspective-card';
  const title=document.createElement('h3');title.textContent=asset.code+' '+asset.name;
  const sub=document.createElement('small');sub.textContent='地图数量 '+asset.count+' · '+(asset.unchanged?'圆脸角色保留原图':'保留原朝向，修复透视');
  const pair=document.createElement('div');pair.className='perspective-pair';
  for(const [key,label] of [['previousSrc','修复前'],['src',asset.unchanged?'当前圆脸角色':'透视修正版']]){
   const figure=document.createElement('figure');figure.className=key==='src'?'new-art':'previous-art';
   const stage=document.createElement('div');stage.className='art-stage';
   const img=document.createElement('img');img.src=asset[key]||asset.src;img.alt=asset.name+' · '+label;img.loading='lazy';
   const guide=document.createElement('div');guide.className='art-guide';guide.setAttribute('aria-hidden','true');stage.append(img,guide);
   const caption=document.createElement('figcaption');caption.textContent=label;
   figure.append(stage,caption);pair.append(figure);
  }
  const download=document.createElement('a');download.href=asset.src;download.download=asset.code+' '+asset.name+'.png';download.textContent='下载透明 PNG';
  card.append(title,sub,pair,download);grid.append(card);
 }
}
$('openAssets').onclick=()=>{skyRenderComparison();skyLibrary.showModal();};
for(const id of ['artGuides','artMirror','artCategory'])$(id).onchange=skyRenderComparison;
const skySyncControls=syncTerrainControls;
syncTerrainControls=function(){skySyncControls();$('terrainDescription').textContent='天空浮岛 · 透视修正版 · 16 种 / 201 件 · 原型保留原朝向，地图沿用原有左右随机规则';};
