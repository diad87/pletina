# Contenido infantil en Propio — 23 de octubre de 2026

**Estado: implementación y diagnóstico; resultado final de app pendiente.**
Se trabaja sólo en `musify-oficial`, rama `p1-oficial`. No se modifica la carpeta
de `main`, no se publica una app o receta y no se usan cuentas, cookies de cuenta
ni perfiles Premium. El corpus consta de tres canciones; no representa todo el
catálogo infantil.

## Control anterior al cambio

La app aislada inició las tres canciones por el respaldo Legacy. La búsqueda
por nombre seleccionó los IDs esperados, pero Native no entregó audio directo.
El cronómetro incluye búsqueda y arranque; «primer sonido» es el evento de
reproducción con avance del reloj y audio silenciado, no una escucha acústica.

| Canción | ID de YouTube | Ruta | Inicio con búsqueda |
|---|---|---|---:|
| Epoitaitaye | `DJzjkMBMook` | Legacy | 4911,4 ms |
| Maite Zaitut! | `WtTRMAoN2Fw` | Legacy | 2322,5 ms |
| Pupu Eta Lore | `kcUgLakr7bU` | Legacy | 2620,8 ms |

Fuente local: ejecución `20261023-080957-784f49c6`, PID 39116. Contadores:
0 Native, 3 fallos Native y 3 Legacy. Las tres filas incumplieron el umbral
de 300 ms. No se ejercitaron EOF, continuidad completa ni medición de anuncios;
los contadores de publicidad ausentes no significan cero anuncios.

## Diagnóstico y cambio

Music devolvió 20 candidatos por consulta y eligió las tres coincidencias con
puntuación 112. No había un filtro local que excluyera estas canciones. En los
casos probados, los clientes rápidos y WEB no daban una URL aceptada; el cliente
incrustado descubierto sí proporcionó formatos cifrados del vídeo solicitado.

La alternativa nueva sólo se habilita tras una respuesta pública que confirma
el ID, reproducción permitida en embed y el aviso explícito de contenido
infantil. Descubre la versión de WEB_EMBEDDED_PLAYER y el reproductor publicado;
analiza éste con youtubei.js 18.1.0/Meriyah y calcula firma y `n` en QuickJS.
No ejecuta el reproductor completo ni automatiza una cuenta. VISIONOS sigue
primero y mantiene su receta; los adultos resueltos por esa ruta no usan JS.
Windows conserva Legacy como respaldo. Android conserva la ruta nativa y carece
de la ventana Legacy.

Los candidatos deben ser audio original, sin DRC ni DRM. Se verifican identidad,
dominio HTTPS, firma y una muestra HTTP 206 completa al 80 % del archivo. Esa
sonda acredita acceso a ese rango, no reproducción íntegra ni EOF.

## Verificado hasta ahora

- El bundle no contiene código descargado del reproductor ni datos de sesiones.
  Su generación es reproducible y supera 10 pruebas dirigidas: extracción sin
  ejecutar el programa completo, offsets, entradas como datos, aislamiento,
  resultados inválidos, límites y bloqueo de `caller`/`callee`.
- El fixture público real produjo el mismo script, ST y firmas/`n` en V8 y
  QuickJS. La preparación en frío de QuickJS tardó 6853,3 ms; cuatro formatos
  coincidieron con los hashes generados en V8. No se infiere esa latencia para
  Android ni para todos los reproductores futuros.
- El prototipo Node obtuvo seis sondas HTTP 206 correctas: inicio y 80 % de tres
  formatos. Esto demuestra aquel fixture y aquellas solicitudes, no un resultado
  equivalente automático del transporte Rust.
- En el primer ensayo directo de Rust, Pupu Eta Lore obtuvo audio aceptado;
  Epoitaitaye y Maite Zaitut! fallaron la sonda. El diagnóstico posterior observó
  HTTP 403 en los tres formatos Opus intentados de cada una de esas dos canciones.
  Un control adulto fue rechazado por la guarda infantil.
- Comparando exactamente las respuestas fallidas, ambos motores produjeron
  firmas/`n` idénticos. `Player.decipher` añadía `cver` a la URL y la reconstrucción
  Rust lo omitía; los demás parámetros eran iguales. La prueba de esa diferencia
  y la resolución de los 403 siguen pendientes en este corte del informe.
- Las comprobaciones de compilación Android x86_64 y arm64 terminaron sin error.
  No equivalen a reproducción instrumentada en un dispositivo Android.

## Límites y privacidad

QuickJS usa un trabajador, pila de 512 KiB y límites de 192 MiB/12 segundos al
preparar y 32 MiB/un segundo al descifrar. La espera del trabajador cuenta en el
plazo; la ruta incrustada completa tiene 30 segundos. La cancelación interrumpe
el trabajo. Se mantienen presupuestos medidos; no se fuerza un límite de cinco
segundos que el primer análisis real no cumplía.

No se proporcionan APIs de red, archivos, DOM, módulos o aplicación al runtime;
el fragmento corre en modo estricto con las entradas públicas de compilación
retiradas. Es aislamiento dentro del proceso, no un sandbox del sistema
operativo. Los errores se reducen a categorías sin URLs ni tokens. Los fixtures
y registros en bruto permanecen en `.local` ignorado y no se copian a este informe.

## Resultados finales pendientes

| Validación | Resultado |
|---|---|
| Tres canciones: resolución directa y app por nombre | Pendiente |
| Reproducción completa y seek con el audio obtenido | Pendiente |
| Regresión de las 30 canciones habituales | Pendiente |
| Transporte de las respuestas que dieron HTTP 403 | Pendiente |
| Ejecución real en Android | No verificada |
| Checks finales y revisión exacta del código ensayado | Pendiente |

No hay aprobación final de compatibilidad ni de latencia en este estado. Los
resultados posteriores deben conservar los intentos fallidos y distinguir la
primera preparación del decoder de la reutilización de su caché.
