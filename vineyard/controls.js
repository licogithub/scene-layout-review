'use strict';
const selectedSyncControls=syncTerrainControls;
syncTerrainControls=function(){selectedSyncControls();$('densitySelect').disabled=Object.keys(DATA.densityProfiles).length===1;$('scatterSelect').disabled=currentLayouts().length===1;$('terrainDescription').textContent=level.name+' · 已确定底图 · 最新素材';};
$('openAssets').onclick=()=>{
 const grid=$('assetCards');grid.replaceChildren();
 for(const asset of DATA.sourceAssets){const card=document.createElement('div');card.className='source-card';const image=document.createElement('img');image.src=asset.src;image.alt=asset.name;const label=document.createElement('div');label.textContent=asset.code+' '+asset.name;const count=document.createElement('small');count.textContent=asset.count?'地图数量：'+asset.count:'未计入当前数量表';card.append(image,label,count);grid.append(card);}
 $('assetLibrary').showModal();
};
$('closeAssets').onclick=()=>$('assetLibrary').close();
const selectedSiteInit=init;
init=async function(){await selectedSiteInit();for(const option of $('level').options){const entry=selectedThemeRoutes[option.value];if(entry)option.textContent=DATA.levels.find(l=>String(l.id)===option.value).name+' · 已接入'+(entry===selectedThemeCurrent?'':'（切换）');}$('densitySelect').disabled=Object.keys(DATA.densityProfiles).length===1;$('scatterSelect').disabled=currentLayouts().length===1;};
