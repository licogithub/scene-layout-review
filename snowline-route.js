'use strict';
const snowlineUrl='snowline.html';
const snowlineLink=document.createElement('a');snowlineLink.href=snowlineUrl;snowlineLink.textContent='雪线矿镇试排';snowlineLink.className='snowline-entry';snowlineLink.style.cssText='padding:6px 10px;border:1px solid #9baec4;border-radius:7px;color:#3b5e7e;font-size:12px;text-decoration:none;background:#eef3f8';document.querySelector('.actions').prepend(snowlineLink);
function routeSnowline(){if(document.getElementById('level').value==='8')location.href=snowlineUrl;}
document.getElementById('level').addEventListener('change',e=>{if(e.target.value==='8'){e.stopImmediatePropagation();routeSnowline();}},true);
function labelSnowline(){const option=document.querySelector('#level option[value="8"]');if(option)option.textContent='雪线矿镇 · 已接入试排';else setTimeout(labelSnowline,100);}
labelSnowline();if(new URLSearchParams(location.hash.slice(1)).get('level')==='8')location.replace(snowlineUrl);
