const files=["assets/figtree-latin-ext-wght-normal-DCwSJGxG.woff2","assets/figtree-latin-wght-normal-D_ZTVpCC.woff2","assets/index-CDL4VedR.js","assets/index-W2XYcCbw.css","assets/p1-recipe.generated-B9VIf5Tl.js","assets/p1-recipe.generated-BGYpK-b1.js","assets/p1check-BK26lOUg.js","assets/storage-BJF4eTjj.js","assets/storage-PSZZs3R7.js","assets/updates.svelte-CaKsDr0l.js","assets/updates.svelte-d2-IJVos.js","assets/youtube-Bk2h8QR1.js","assets/youtube-p1-D6JsRkrB.js","assets/youtube-p1-probe-D3C8r15R.js","index.2e2da91c415cb452.html","p1-check.html"];
export async function mountPlayer(){
await Promise.all(files.map(async path=>{const response=await fetch(new URL(path,import.meta.url));if(!response.ok)throw new Error('No se pudo descargar Pletina.');await response.arrayBuffer();}));
location.replace(new URL("index.2e2da91c415cb452.html",import.meta.url).href);return {destroy(){}};
}
