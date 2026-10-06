import '@fontsource-variable/figtree'
import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

// En la app instalada, sin el menú contextual del navegador (salvo en campos de texto).
if (!import.meta.env.DEV) {
  document.addEventListener('contextmenu', (e) => {
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault()
  })
}

const app = mount(App, {
  target: document.getElementById('app')!,
})

// Vista previa en un navegador normal: permite abrir una pantalla desde la dirección (capturas).
if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
  import('./dev/preview').then((m) => m.apply())
}

export default app
