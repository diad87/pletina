const files=["assets/figtree-latin-ext-wght-normal-DCwSJGxG.woff2","assets/figtree-latin-wght-normal-D_ZTVpCC.woff2","assets/index-DbgZJMg7.js","assets/index-W2XYcCbw.css","assets/p1-recipe.generated-BtxtnceM.js","assets/p1-recipe.generated-C4oQvyrS.js","assets/p1check-eElhzM6G.js","assets/storage-BJF4eTjj.js","assets/storage-PSZZs3R7.js","assets/updates.svelte-CaKsDr0l.js","assets/updates.svelte-d2-IJVos.js","assets/youtube-Bnw5FnW6.js","assets/youtube-p1-OeC5GoPm.js","assets/youtube-p1-probe-B9_PRGjk.js","index.a6edded3871b0749.html","p1-check.html"];
export async function mountPlayer(){
await Promise.all(files.map(async path=>{const response=await fetch(new URL(path,import.meta.url));if(!response.ok)throw new Error('No se pudo descargar Pletina.');await response.arrayBuffer();}));
location.replace(new URL("index.a6edded3871b0749.html",import.meta.url).href);return {destroy(){}};
}
