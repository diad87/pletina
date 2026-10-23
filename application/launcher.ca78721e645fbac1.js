const files=["assets/figtree-latin-ext-wght-normal-DCwSJGxG.woff2","assets/figtree-latin-wght-normal-D_ZTVpCC.woff2","assets/index-B0QH1TWv.js","assets/index-BzWVG3zr.css","assets/p1-recipe.generated-B9VIf5Tl.js","assets/p1-recipe.generated-BGYpK-b1.js","assets/p1check-BYRRygxV.js","assets/updates.svelte-CaKsDr0l.js","assets/updates.svelte-d2-IJVos.js","assets/youtube-C0AU-eJn.js","assets/youtube-p1-BE43ChRe.js","assets/youtube-p1-probe-DF1rSiy4.js","index.da45d99da3817bac.html","p1-check.html"];
export async function mountPlayer(){
await Promise.all(files.map(async path=>{const response=await fetch(new URL(path,import.meta.url));if(!response.ok)throw new Error('No se pudo descargar Pletina.');await response.arrayBuffer();}));
location.replace(new URL("index.da45d99da3817bac.html",import.meta.url).href);return {destroy(){}};
}
