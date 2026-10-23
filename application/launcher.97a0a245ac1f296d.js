const files=["assets/figtree-latin-ext-wght-normal-DCwSJGxG.woff2","assets/figtree-latin-wght-normal-D_ZTVpCC.woff2","assets/index-CthTmUxG.css","assets/index-D54kqzp3.js","assets/p1-recipe.generated-B9VIf5Tl.js","assets/p1-recipe.generated-BGYpK-b1.js","assets/p1check-CvK81Rq4.js","assets/updates.svelte-CaKsDr0l.js","assets/updates.svelte-d2-IJVos.js","assets/youtube-OlVfgcSX.js","assets/youtube-p1-CST2XekA.js","assets/youtube-p1-probe-DF1rSiy4.js","index.3a8f503bc79fb44b.html","p1-check.html"];
export async function mountPlayer(){
await Promise.all(files.map(async path=>{const response=await fetch(new URL(path,import.meta.url));if(!response.ok)throw new Error('No se pudo descargar Pletina.');await response.arrayBuffer();}));
location.replace(new URL("index.3a8f503bc79fb44b.html",import.meta.url).href);return {destroy(){}};
}
