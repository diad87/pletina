# Casos de estabilidad de Pletina

Índice de los 70 casos preparados. Los pasos, resultados esperados, evidencias, dependencias y estado previo están en [la matriz completa](cases.json). Cada caso se expande por las combinaciones de entorno del [plan](../auditoria-estabilidad.md). No son 70 pruebas ya ejecutadas.

## Android

| Caso | Prioridad | Escenario |
| --- | --- | --- |
| AND-001 | P0 | Instalación limpia del APK firmado en la matriz Android declarada, separando incompatibilidad de ABI de un fallo de instalación. |
| AND-002 | P0 | Actualizar de 0.9.0 y 0.9.1 a 0.10.0/candidato y de 0.10.0 a un candidato futuro, sin perder biblioteca, descargas o identidad. |
| AND-003 | P0 | Reproducir música del catálogo y canciones añadidas mediante enlace YouTube usando el motor móvil real. |
| AND-004 | P0 | Episodio RSS largo con seek, redirecciones y HTTP Range, identificado por enclosure real. |
| AND-005 | P1 | Comparación controlada de pódcasts RSS y YouTube entre versiones. |
| AND-006 | P0 | Continuidad al cerrar Activity, bloquear pantalla y retirar la app de recientes. |
| AND-007 | P1 | Doze/standby y política OEM durante reproducción o pausa prolongada. |
| AND-008 | P0 | Foco transitorio/permanente por navegación, llamada y otra app, sin reanudaciones que contradigan una pausa. |
| AND-009 | P0 | Desconexión/reconexión Bluetooth A2DP y auriculares durante reproducción, pausa y retry. |
| AND-010 | P1 | Descubrimiento, biblioteca, arranque sin Activity y controles de Android Auto. |
| AND-011 | P0 | Cuatro cortes independientes durante una misma pista con recuperación estable entre ellos. |
| AND-012 | P0 | Transporte móvil/Wi-Fi presente sin acceso real a Internet y recuperación posterior. |
| AND-013 | P0 | Pausa, cambio de pista, limpieza de cola y destrucción durante callbacks de retry o vuelta de red. |
| AND-014 | P1 | Wi-Fi→datos→Wi-Fi, URL caducada/403 y renovación sin perder posición. |
| AND-015 | P1 | Cola con streaming y descargas durante pérdida de red, repeat/shuffle y ausencia de siguiente descarga. |
| AND-016 | P1 | Órdenes rápidas, duplicados, cola manual, shuffle/repeat y retorno de UI congelada. |
| AND-017 | P0 | Reapertura después de muerte de proceso, recreación de Activity y forzar detención como caso distinto. |
| AND-018 | P0 | Descargar varias pistas mientras suena música, se apaga pantalla y se deniega permiso de notificaciones. |
| AND-019 | P0 | Cancelación, corte de red, cierre y disco lleno durante escritura de descarga. |
| AND-020 | P1 | Favoritos RSS/YouTube, artistas, playlists e historial sobreviven a reinicio y eliminación selectiva. |
| AND-021 | P1 | Cada fallo de reproducción/servicio produce evidencia útil y el registro se puede compartir. |
| AND-022 | P1 | Sesiones de resistencia de 8 h de música y 2 h de pódcasts en streaming con pantalla apagada, transiciones y cambios de red. |

## Windows macOS y Linux

| Caso | Prioridad | Escenario |
| --- | --- | --- |
| DESK-WIN-001 | P0 | Primera instalación NSIS con y sin WebView2. |
| DESK-WIN-002 | P1 | Instalación por usuario con espacios, tildes y caracteres no latinos. |
| DESK-WIN-003 | P0 | Actualización al salir y Reiniciar, incluida migración legado Musify cuando exista artefacto. |
| DESK-WIN-004 | P0 | Audio local, YouTube, descarga offline y respaldo de extractores en paquete instalado. |
| DESK-WIN-005 | P0 | Segunda invocación, minimizar y cerrar con captura o descarga activa. |
| DESK-WIN-006 | P1 | Suspender, bloquear y cambiar salida durante audio local/remoto. |
| DESK-WIN-007 | P1 | Reinstalar y desinstalar conservando datos cuando esa opción proceda. |
| DESK-MAC-001 | P0 | Instalación y ejecución nativa del DMG universal en ambas arquitecturas. |
| DESK-MAC-002 | P0 | Primera apertura con cuarentena y firma ad hoc. |
| DESK-MAC-003 | P0 | Streaming M4A, audio offline y capacidades reales del respaldo en macOS. |
| DESK-MAC-004 | P0 | Actualizar tar.gz firmado desde versión anterior. |
| DESK-MAC-005 | P1 | Cerrar tapa, cambiar salida, Cmd-Q y cerrar ventana principal. |
| DESK-MAC-006 | P1 | Unicode, permisos de carpeta y retirada de volumen externo. |
| DESK-LIN-001 | P0 | Arranque por FUSE y extracción, desde entorno limpio. |
| DESK-LIN-002 | P0 | Instalación y upgrade DEB mediante apt. |
| DESK-LIN-003 | P0 | Siete codecs usando únicamente bibliotecas/plugins del paquete. |
| DESK-LIN-004 | P0 | Seis formatos locales y descarga WebM con seek/pausa/reanudar. |
| DESK-LIN-005 | P0 | HEAD, Range y registro de más de512 archivos. |
| DESK-LIN-006 | P0 | YouTube con Node incluido, descarga offline y actualización. |
| DESK-LIN-007 | P1 | Suspender, cambiar salida y cerrar en PulseAudio/PipeWire. |
| DESK-ALL-001 | P1 | Soak por plataforma: ocho horas de música y dos horas de pódcast. |
| DESK-ALL-002 | P0 | Cien cierres/aperturas con biblioteca y ajustes. |
| DESK-ALL-003 | P0 | Terminación forzada, disco lleno y DB inválida en fixtures desechables. |
| DESK-ALL-004 | P0 | Arquitectura, firmas incorrectas, descarga truncada y cortes. |

## Núcleo datos y reproducción compartida

| Caso | Prioridad | Escenario |
| --- | --- | --- |
| CORE-DB-001 | P0 | Actualizar perfiles creados por v0.9.0 y v0.9.1 (esquema 5) a la versión auditada sin perder datos. |
| CORE-DB-002 | P0 | Migrar esquema 6 a 7 y reabrir repetidamente, conservando artistas, enlaces YouTube y datos de episodios. |
| CORE-DB-003 | P0 | Recuperar datos confirmados en WAL y proteger backup/migraciones frente a cierre forzado o falta de espacio. |
| CORE-DB-004 | P0 | DB de solo lectura, llena, bloqueada o corrupta durante favoritos, ajustes, historial y selección de vídeo. |
| CORE-DB-005 | P0 | Escrituras concurrentes de biblioteca, historial, descargas e importación al cerrar y reabrir. |
| CORE-LIB-006 | P1 | Persistencia y eliminación independiente de favoritos, playlists, artistas, programas y enlaces YouTube. |
| CORE-DL-007 | P1 | Duplicados, colisiones de nombre y cancelación de una tanda con dos descargas concurrentes. |
| CORE-DL-008 | P0 | Directorio no escribible, disco lleno, fallo de renombrado y eliminación denegada. |
| CORE-DL-009 | P0 | Corte de conexión o cierre durante descarga parcial, renovación 403 y cambio de formato. |
| CORE-DL-010 | P1 | Inicialización, reinicio y eventos terminales durante cambios de vista o errores IPC. |
| CORE-IMP-011 | P1 | CSV de distintas variantes y playlist pública Spotify truncada, privada o con HTML cambiado. |
| CORE-IMP-012 | P1 | Cancelar o salir mientras se lee/busca una playlist y recibir después respuestas antiguas. |
| CORE-IMP-013 | P1 | Interrumpir matching por red, reanudar desde el primer pendiente y cerrar durante guardado. |
| CORE-EXT-014 | P1 | Arranque frío y caliente del motor, falta de runtime y servidor de descarga de extractor lento o caído. |
| CORE-EXT-015 | P0 | Canal firmado, archivo corrupto, API incompatible y cierre entre guardar código y metadatos. |
| CORE-EXT-016 | P0 | Caché válida/caducada, HTTP403 inicial o a mitad y validación del tramo final de URL. |
| CORE-EXT-017 | P0 | Elegir vídeo alternativo con reproducción/descarga activa y conservar enlaces YouTube explícitos. |
| CORE-PLY-018 | P0 | Mantener la cobertura conocida de carga, MediaSession, fallos, reproducción local y carreras de cola. |
| CORE-PLY-019 | P0 | Audio que deja de avanzar tras waiting/stalled sin emitir error terminal. |
| CORE-PLY-020 | P1 | play() al reanudar devuelve rechazo o queda pendiente, frente al arranque inicial protegido por timeout. |
| CORE-POD-021 | P0 | Ensayo prolongado de pódcasts en streaming y comparación controlada entre versiones. |
| CORE-POD-022 | P1 | Buscar a posiciones lejanas, pausar/reanudar y llegar al final en RSS y YouTube de larga duración. |
| CORE-OBS-023 | P1 | Cada fallo se puede repetir y separar entre UI, extractor, transporte, códec y persistencia. |
| CORE-DL-024 | P1 | Descargas completas offline, archivo movido/borrado y retorno controlado al streaming. |
