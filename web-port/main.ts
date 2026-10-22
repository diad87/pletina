import '@fontsource-variable/figtree'
import { mount } from 'svelte'
import '../src/app.css'
import App from '../src/App.svelte'
import UpdateBanner from './UpdateBanner.svelte'
import { initWebUpdates } from './updates.svelte'
import { initWebNavigation, ROOT_EXIT_WINDOW_MS } from './navigation'
import { initWebViewport } from './viewport'
import { nav } from '../src/lib/nav.svelte'
import { layout } from '../src/lib/layout.svelte'
import { toast } from '../src/lib/toast.svelte'

// La interfaz y el reproductor proceden de 0.11.2. Las peticiones usan webInvoke.
initWebViewport((visible) => { layout.keyboard = visible })
initWebNavigation(nav, window, { onExitArmed: () => toast.show('Pulsa Atrás otra vez para salir', ROOT_EXIT_WINDOW_MS) })
mount(App, { target: document.getElementById('app')! })
mount(UpdateBanner, { target: document.body })
void initWebUpdates()
try { localStorage.setItem('pletina:web:opened', '1') } catch { /* Sin persistencia. */ }
