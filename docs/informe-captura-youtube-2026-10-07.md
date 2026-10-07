# P1 — Captura oficial, 7 de octubre de2026

Trabajo en `p1-oficial`, worktree `musify-oficial`. API4/captura v8 en validación. No se ha hecho
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
| JavaScript | 278 correctas,0 omitidas |
| Rust | 82 correctas,13 integraciones ignoradas; descarga CDN real comprobada aparte |
| TypeScript/Svelte | 0 errores y0 avisos |
| Compilación Rust de producción | Correcta |

| Medición nueva en la app | Sin Premium | Premium, referencia |
|---|---|---|
| Propio: búsqueda + primer sonido | 30/30 usan Rust,0 respaldos;506–1203ms, mediana675,5ms;0/30 cumplen300ms | Pendiente |
| Propio: siguiente canción | Pendiente | Pendiente |
| Oficial: primer sonido y espera publicitaria | Ensayo v7: Airbag25,408s, anuncio observado20,043s; Preso9,742s, anuncio observado6,014s; incumplen3s restantes | Pendiente |
| Oficial: siguiente canción y salto80% | Siguiente pendiente; ensayo v7 saltos2,029/2,067s, incumplen1s | Pendiente |
| Anuncios omitidos mediante clic confiable + transición | Ensayo v7:0 solicitudes/0 clics; no apareció botón conocido | Pendiente |
| Comparación independiente30 canciones/50 transiciones | Pendiente | No contribuye a aprobar |

La batería no se da por aprobada por pasar tests. Los umbrales y el alcance están en el
[plan vigente](plan-captura-youtube.md). El caso controlado con marcador retrasado1,7s
sigue detectando180ms de publicidad experimental frente a una retención de1,5s.
Velocidad normal1×; no se ha aprobado aceleración segura de anuncios o contenido.

Las evidencias históricas se movieron sin cambiar sus32 hashes a
`capture-evidence.local/legacy-2026-10-07/`, ignorada por Git. Aquellas mediciones mezclan
versiones y no comparan audio independiente ni prueban sesión cerrada; no cuentan en
la nueva aprobación. Se conserva un [resumen](evidence/capture-2026-10-07/README.md).

El usuario confirmó el acceso manual Premium y el perfil separado observó sesión iniciada.
La búsqueda válida es `result-20261007-212633.json`, con el corpus UTF8 del repositorio.
El ensayo oficial `213401` se agotó a600s: la referencia larga falló por descarga interrumpida
y las comprobaciones periódicas quedaron en cola. No aprueba ni publicidad ni cobertura.
Una ejecución anterior con texto mal codificado (`212348`) queda excluida y conservada.
El analizador del ensayo incompleto no permite medir la demora real de la señal.

Corregidos para la siguiente batería: descarga por rangos (Airbag4.882.214bytes en465ms),
verificación de referencia entera y ventanas de muestras, PCM con desplazamiento declarado,
comparador sin cola acumulativa, cierre confirmado del probe y recuperación nueva desde cero
ante cuantización tras seek. Se solapa visitante con búsqueda y se miden sus fases sin
quitar la sonda del audio al80%.

Pendientes: medir v8 en la app, completar30 canciones/50 transiciones anónimas y las pocas
referencias Premium, medir señales con referencia externa y evaluar velocidad segura.
Esta tabla es provisional y conserva también los intentos fallidos.
