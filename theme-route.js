'use strict';
const selectedThemeRoutes={"2": "index.html", "8": "snowline.html", "9": "windmill.html", "4": "sky-islands.html"};

const selectedThemeCurrent=location.pathname.split('/').pop()||'index.html';
const selectedThemeRequested=new URLSearchParams(location.hash.slice(1)).get('level');
if(selectedThemeRoutes[selectedThemeRequested]&&selectedThemeRoutes[selectedThemeRequested]!==selectedThemeCurrent)location.replace(selectedThemeRoutes[selectedThemeRequested]+location.hash);
document.getElementById('level').addEventListener('change',event=>{
 const destination=selectedThemeRoutes[event.target.value];
 if(destination&&destination!==selectedThemeCurrent){event.stopImmediatePropagation();location.href=destination;}
},true);
