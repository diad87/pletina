const files=["assets/figtree-latin-ext-wght-normal-DCwSJGxG.woff2","assets/figtree-latin-wght-normal-D_ZTVpCC.woff2","assets/index-BzWVG3zr.css","assets/index-DqotjOp_.js","index.16cafc15d31e9e20.html"];
export async function mountPlayer(){
await Promise.all(files.map(async path=>{const response=await fetch(new URL(path,import.meta.url));if(!response.ok)throw new Error('No se pudo descargar Pletina.');await response.arrayBuffer();}));
location.replace(new URL("index.16cafc15d31e9e20.html",import.meta.url).href);return {destroy(){}};
}
