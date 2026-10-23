const files=["assets/figtree-latin-ext-wght-normal-DCwSJGxG.woff2","assets/figtree-latin-wght-normal-D_ZTVpCC.woff2","assets/index-BzWVG3zr.css","assets/index-CxLHVpB4.js","index.af54cfc7b1a95e2f.html"];
export async function mountPlayer(){
await Promise.all(files.map(async path=>{const response=await fetch(new URL(path,import.meta.url));if(!response.ok)throw new Error('No se pudo descargar Pletina.');await response.arrayBuffer();}));
location.replace(new URL("index.af54cfc7b1a95e2f.html",import.meta.url).href);return {destroy(){}};
}
