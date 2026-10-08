import '@fontsource-variable/figtree'
import { mount } from 'svelte'
import './app.css'
import { ipcReady } from './lib/api'
import { extractor } from './lib/extractor/engine.svelte'

// Antes de nada, que Rust conteste (en Android tarda un instante al arrancar). La app se carga
// después: así el reproductor y las pantallas ya pueden pedirle cosas.
await ipcReady
const { default: App } = await import('./App.svelte')

// En la app instalada, sin el menú contextual del navegador (salvo en campos de texto).
if (!import.meta.env.DEV) {
  document.addEventListener('contextmenu', (e) => {
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault()
  })
}

// Prototipo P1: motor youtubei.js (escucha las peticiones de Rust si se elige).
extractor.start()

const app = mount(App, {
  target: document.getElementById('app')!,
})

// Vista previa en un navegador normal: permite abrir una pantalla desde la dirección (capturas).
if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
  import('./dev/preview').then((m) => m.apply())
}

export default app
