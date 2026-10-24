const files=["assets/figtree-latin-ext-wght-normal-DCwSJGxG.woff2","assets/figtree-latin-wght-normal-D_ZTVpCC.woff2","assets/index-KloXT6Z1.css","assets/index-Qtx4Iifn.js","assets/p1-recipe.generated-BtxtnceM.js","assets/p1-recipe.generated-C4oQvyrS.js","assets/p1check-eElhzM6G.js","assets/storage-H4YP9eR3.js","assets/storage-ON5O59yG.js","assets/updates.svelte-DWJ4lW8D.js","assets/updates.svelte-DZqi8l40.js","assets/youtube-Bnw5FnW6.js","assets/youtube-p1-OeC5GoPm.js","assets/youtube-p1-probe-B9_PRGjk.js","index.5c4b8e0fbdd5fd0b.html","p1-check.html"];
export async function mountPlayer(){
await Promise.all(files.map(async path=>{const response=await fetch(new URL(path,import.meta.url));if(!response.ok)throw new Error('No se pudo descargar Pletina.');await response.arrayBuffer();}));
location.replace(new URL("index.5c4b8e0fbdd5fd0b.html",import.meta.url).href);return {destroy(){}};
}
