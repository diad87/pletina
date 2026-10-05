import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { extractor } from './lib/extractor/engine.svelte'

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

export default app
