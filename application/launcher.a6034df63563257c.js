const files=["assets/figtree-latin-ext-wght-normal-DCwSJGxG.woff2","assets/figtree-latin-wght-normal-D_ZTVpCC.woff2","assets/index-C3UQ1I-9.css","assets/index-pDy3iFgl.js","index.7537ce85bd4c59da.html"];
export async function mountPlayer(){
await Promise.all(files.map(async path=>{const response=await fetch(new URL(path,import.meta.url));if(!response.ok)throw new Error('No se pudo descargar Pletina.');await response.arrayBuffer();}));
location.replace(new URL("index.7537ce85bd4c59da.html",import.meta.url).href);return {destroy(){}};
}
