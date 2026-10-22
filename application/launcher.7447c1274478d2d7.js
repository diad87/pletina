const files=["assets/figtree-latin-ext-wght-normal-DCwSJGxG.woff2","assets/figtree-latin-wght-normal-D_ZTVpCC.woff2","assets/index-DRgb_ML0.js","assets/index-Dhe7ruI3.css","index.31173812f4d4929b.html"];
export async function mountPlayer(){
await Promise.all(files.map(async path=>{const response=await fetch(new URL(path,import.meta.url));if(!response.ok)throw new Error('No se pudo descargar Pletina.');await response.arrayBuffer();}));
location.replace(new URL("index.31173812f4d4929b.html",import.meta.url).href);return {destroy(){}};
}
