'use strict';
const windmillRoutes={'2':'index.html','8':'snowline.html','9':'windmill.html'};
const windmillCurrent=location.pathname.split('/').pop()||'index.html';
const windmillActions=document.querySelector('.actions');
if(windmillCurrent!=='windmill.html'&&!windmillActions.querySelector('[data-theme="windmill"]')){
 const a=document.createElement('a');a.href='windmill.html';a.dataset.theme='windmill';a.textContent='风车麦田试排';a.className='level-return';a.style.cssText='padding:6px 10px;border:1px solid #c5af76;border-radius:7px;color:#74613b;font-size:12px;text-decoration:none;background:#fbf6e9';windmillActions.prepend(a);
}
if(windmillCurrent==='windmill.html'){
 const a=document.createElement('a');a.href='snowline.html';a.textContent='雪线矿镇';a.className='level-return';windmillActions.prepend(a);
}
document.getElementById('level').addEventListener('change',e=>{
 const dest=windmillRoutes[e.target.value];if(dest&&dest!==windmillCurrent){e.stopImmediatePropagation();location.href=dest;}
},true);
function labelWindmillLevels(){
 const options=[...document.querySelectorAll('#level option')];if(!options.length){setTimeout(labelWindmillLevels,100);return;}
 for(const [id,label]of [['2','大峡谷'],['8','雪线矿镇'],['9','风车麦田']]){
  const o=options.find(o=>o.value===id);if(o)o.textContent=label+' · 已接入'+(windmillRoutes[id]===windmillCurrent?'':'（切换）');
 }
}
labelWindmillLevels();
const requestedLevel=new URLSearchParams(location.hash.slice(1)).get('level');
if(requestedLevel&&windmillRoutes[requestedLevel]&&windmillRoutes[requestedLevel]!==windmillCurrent)location.replace(windmillRoutes[requestedLevel]);
