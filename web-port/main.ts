import '@fontsource-variable/figtree'
import { mount } from 'svelte'
import '../src/app.css'
import App from '../src/App.svelte'
import UpdateBanner from './UpdateBanner.svelte'
import { initWebUpdates } from './updates.svelte'

// La interfaz y el reproductor proceden de 0.11.2. Las peticiones usan webInvoke.
mount(App, { target: document.getElementById('app')! })
mount(UpdateBanner, { target: document.body })
void initWebUpdates()
try { localStorage.setItem('pletina:web:opened', '1') } catch { /* Sin persistencia. */ }
