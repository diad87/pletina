# P1 — Captura oficial, 7 de octubre de2026

Trabajo en `p1-oficial`, worktree `musify-oficial`. API4/captura v7. No se ha hecho
push, fusión ni publicación. Propio conserva el nivel rápido y el respaldo histórico;
yt-dlp sigue predeterminado. La promoción progresiva depende de la batería nueva.

Implementados clic nativo revalidado, retención configurable de1,5s, dos precargas,
límites de memoria, certificado EOF con índices de paquetes y perfiles de pruebas
separados. El banco descarga una referencia sin cookies y compara todas las unidades
publicadas, conservadas en un diario local incluso tras expulsar caché. El fallback PCM
exige muestras y tiempos exactos; no ajusta libremente el origen para buscar coincidencias.

El probe opcional guarda también datos retenidos y relojes del reproductor, para estudiar
el retraso de las señales. Un registro truncado o sin cierre queda sin medir. Audio distinto
de la referencia no se denomina anuncio automáticamente.

| Comprobación de código | Resultado |
|---|---|
| JavaScript | 256 correctas,0 omitidas |
| Rust | 67 correctas,12 integraciones ignoradas |
| TypeScript/Svelte | 0 errores y0 avisos |
| Compilación Rust de producción | Correcta |

| Medición nueva en la app | Sin Premium | Premium, referencia |
|---|---|---|
| Propio: búsqueda + primer sonido | Pendiente | Pendiente |
| Propio: siguiente canción | Pendiente | Pendiente |
| Oficial: primer sonido y espera publicitaria | Pendiente | Pendiente |
| Oficial: siguiente canción y salto80% | Pendiente | Pendiente |
| Anuncios omitidos mediante clic confiable + transición | Pendiente | Pendiente |
| Comparación independiente30 canciones/50 transiciones | Pendiente | No contribuye a aprobar |

La batería no se da por aprobada por pasar tests. Los umbrales y el alcance están en el
[plan vigente](plan-captura-youtube.md). El caso controlado con marcador retrasado1,7s
sigue detectando180ms de publicidad experimental frente a una retención de1,5s.
Velocidad normal1×; no se ha aprobado aceleración segura de anuncios o contenido.

Las evidencias históricas se movieron sin cambiar sus32 hashes a
`capture-evidence.local/legacy-2026-10-07/`, ignorada por Git. Aquellas mediciones mezclan
versiones y no comparan audio independiente ni prueban sesión cerrada; no cuentan en
la nueva aprobación. Se conserva un [resumen](evidence/capture-2026-10-07/README.md).

Pendientes: ejecutar la batería nueva dentro de la app, completar el acceso Premium
manual, medir señales con referencia externa y evaluar velocidad sin acelerar anuncios.
Los resultados cerrados y sus diagnósticos sustituirán esta tabla provisional.
