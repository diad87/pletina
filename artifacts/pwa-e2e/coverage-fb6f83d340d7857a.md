# Cobertura E2E de Pletina PWA

Build: fb6f83d340d7857a. Generado: 2026-10-19T07:36:45.053Z.

Resultados de comprobaciones de navegador: pass 169, fail 0, blocked 0, unsupported 5.

Casos del inventario actual ausentes en las ejecuciones elegidas: 0.

Android físico e iPhone físico pendientes; Android Auto y CarPlay no están implementados en esta distribución PWA.

Los resultados usan la aplicación compilada, service worker, IndexedDB y audio reales, con respuestas HTTP de proveedores controladas. La emulación de diseño no acredita el sistema operativo. Un caso agrupado fallido no acredita sus pasos posteriores.

| Comprobación | chromium-android-layout | firefox-narrow | webkit-iphone-layout |
| --- | --- | --- | --- |
| setup.open: install shell and open compiled application | pass | pass | pass |
| setup.fixture: opaque-frame catalog requests are controlled | pass | pass | pass |
| install.minimal: initial entry avoids all application assets | pass | pass | pass |
| install.manifest: stable scope, standalone identity and icon resources | pass | pass | pass |
| install.guide: platform instructions open and close | pass | pass | pass |
| install.offline: cached entry reloads with the network disconnected | pass | pass | pass |
| install.native-prompt: actual phone installation | unsupported | unsupported | unsupported |
| library.navigation: four tabs, browser history, reload and viewport | pass | pass | pass |
| library.discovery: home cards and empty history | pass | pass | pass |
| library.search: tracks, artists, albums and expanded results | pass | pass | pass |
| library.search: natural song de artist retries the empty literal query | pass | pass | pass |
| library.search: empty results and partial-provider retry remain explicit | pass | pass | pass |
| library.artist: detail, favorites and discography filters | pass | pass | pass |
| library.album: detail, save, pin and library persistence | pass | pass | pass |
| library.home-and-menus: song destinations, recent cards and direct unpin | pass | pass | pass |
| library.favorites: like, search, clear and remove one song | pass | pass | pass |
| library.playlists: create, rename/cancel and pin | pass | pass | pass |
| library.playlists: append album, duplicate entries, filter and reorder | pass | pass | pass |
| library.csv: visible Spotify limit, invalid CSV, retry, review and save | pass | pass | pass |
| library.csv-validation: size limit, all omitted, empty name and cancel | pass | pass | pass |
| library.source-picker: candidates, invalid link, manual choice and remembered source | pass | pass | pass |
| library.youtube: preview, edit, save/update and remove personal link | pass | pass | pass |
| library.podcasts: RSS/YouTube catalogs, language filtering and saved-show reload | pass | pass | pass |
| library.persistence: saved artist/album and pin removal survive reload | pass | pass | pass |
| library.playlists: cancellation and permanent deletion remove the pinned list | pass | pass | pass |
| library.contextual-playlist: create from a song and delete the temporary list | pass | pass | pass |
| library.history: recorded plays, cancel clear, clear and reload | pass | pass | pass |
| responsive.resize: query and dock survive portrait, desktop and short landscape | pass | pass | pass |
| responsive.resume: navigation survives lifecycle signals and reload after resizing | pass | pass | pass |
| media.selection-html-audio | pass | pass | pass |
| media.pause-seek-next-previous-one-audio | pass | pass | pass |
| media.media-session-metadata-and-idempotent-actions | pass | pass | pass |
| media.now-playing-synthetic-touch-swipe-threshold-and-interactive-origin | pass | pass | pass |
| media.home-surprise-album-starts-saved-album-in-track-order | pass | pass | pass |
| media.artist-radio-builds-bounded-mixed-queue-and-plays | pass | pass | pass |
| media.context-play-next-prepends-dj-priority-without-interrupting-current | pass | pass | pass |
| media.dj-duplicates-reorder-play-remove-clear | pass | pass | pass |
| media.shuffle-preserves-current-and-queue-membership | pass | pass | pass |
| media.repeat-one-real-ended | pass | pass | pass |
| media.repeat-all-wraps-after-final-entry | pass | pass | pass |
| media.automatic-next-real-ended-same-audio | pass | pass | pass |
| media.sleep-at-end-does-not-start-prepared-successor | pass | pass | pass |
| media.sleep-custom-validation-and-one-minute-deadline | pass | pass | pass |
| media.pause-during-delayed-resolution-prevents-late-autoplay | pass | pass | pass |
| media.rapid-song-selection-ignores-obsolete-player-response | pass | pass | pass |
| media.provider-errors-stop-boundedly-and-explicit-retry-recovers | pass | pass | pass |
| media.reload-restores-current-dj-position-and-paused-intent | pass | pass | pass |
| media.downloads-serial-duplicate-suppression-and-cancel-pending | pass | pass | pass |
| media.download-offline-reload-play-seek-from-local-service-worker | pass | pass | pass |
| media.download-removal-clears-pointer-body-and-ui | pass | pass | pass |
| media.download-quotaFailure-rollback-and-no-false-done | pass | pass | unsupported |
| media.download-storageFailure-rollback-and-no-false-done | pass | pass | pass |
| media.download-failMedia-rollback-and-no-false-done | pass | pass | pass |
| media.download-retry-after-provider-failure-succeeds | pass | pass | pass |
| media.rss-podcast-direct-audio-progress-reload-and-resume | pass | pass | pass |
| media.rss-completion-next-episode-and-relisten-from-zero | pass | pass | pass |
| media.youtube-podcast-keeps-episode-namespace-and-progress | pass | pass | pass |
| media.audio-log-export-is-local-bounded-and-has-no-source-addresses | unsupported | pass | pass |

## Evidencia adicional

- service-worker-update-and-data-migration: 7/7 pass. artifacts/pwa-port/update-e2e-fb6f83d340d7857a.json
- live-provider-search-and-playback: 3/3 pass. artifacts/pwa-port/browser-public-e2e-user-song-fb6f83d340d7857a.json

## Fuentes elegidas

- artifacts/pwa-e2e/release-fb6f83d340d7857a-win/summary.json
- artifacts/pwa-e2e/release-fb6f83d340d7857a-linux/summary.json
