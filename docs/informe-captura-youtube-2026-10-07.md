# P1 — Captura oficial, 7 de octubre de2026

Trabajo en `p1-oficial`, worktree `musify-oficial`. API4/captura v12 en validación. No se ha hecho
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
| JavaScript | 300 correctas,0 omitidas;110 núcleo/MP4 posteriores correctas |
| Rust | 90 correctas,13 integraciones ignoradas; descarga CDN real comprobada aparte |
| TypeScript/Svelte | 0 errores y0 avisos |
| Compilación Rust de producción | Correcta |

| Medición nueva en la app | Sin Premium | Premium, referencia |
|---|---|---|
| Propio: búsqueda + primer sonido | 30/30 usan Rust,0 respaldos;506–1203ms, mediana675,5ms;0/30 cumplen300ms | Pendiente |
| Propio: siguiente canción | Pendiente | Pendiente |
| Oficial: primer sonido y espera publicitaria | Ensayo v7: Airbag25,408s, anuncio observado20,043s; Preso9,742s, anuncio observado6,014s; incumplen3s restantes | Pendiente |
| Oficial: siguiente canción y salto80% | Siguiente pendiente; ensayo v7 saltos2,029/2,067s, incumplen1s | Pendiente |
| Anuncios omitidos mediante clic confiable + transición | v8: botón visible;13 solicitudes rechazadas antes del clic,0 saltos confirmados | Pendiente |
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

El ensayo v8 `220141`, sin sesión y sin seek, verificó la referencia completa de PRESO:
2035/2035 paquetes coinciden y ninguna unidad publicada discrepa. Primer sonido25,633s,
señal publicitaria observada19,999s; hubo una espera real de10,1ms a los39,14s.
No aprueba tiempos ni continuidad. Se corrige el lector para esperar0,5s continuos aceptados
por MSE, y el clic nativo para aceptar enteros seguros que WebView2 serializa como decimal.
El siguiente ensayo debe comprobar ambos arreglos en la app.

Pendientes: medir v12 en la app, completar30 canciones/50 transiciones anónimas y las pocas
referencias Premium, medir señales con referencia externa y evaluar velocidad segura.
Esta tabla es provisional y conserva también los intentos fallidos.

Repetición `222302`, commit8b1704b: PRESO completa sin sesión,2035/2035 paquetes iguales,
0 discrepancias y0 esperas durante reproducción (el seek de comprobación final se registra
aparte). Primer sonido11,468s, señal publicitaria6,016s y resto5,452s: falla el tiempo.
Ese anuncio no mostró botón;0 solicitudes nativas y0 saltos confirmados.

Tanda nativa `222456`:30/30 rápidas,0 respaldo; mediana697,85ms. Búsqueda388,184ms,
Player103,938ms, validación57,221ms y arranque de audio41,5ms (medianas por fase,
no suman necesariamente la mediana total). La búsqueda sola supera300ms en28/30.

Premium `222539` se interrumpió tras repetirse tres recuperaciones: PRESO empieza
en4,660s sin señal publicitaria, pero Music AAC prepara otro vídeo a los30,5s,
cambiando appendWindow de0..40,69 a40,69..288,2 (y otros finales). El rechazo evita
mezclar audio, pero no hay EOF certificado ni transición a MALAMENTE. No se aprueba.
La interrupción limita la exposición de la cuenta; el checkpoint se conserva fuera de Git.
