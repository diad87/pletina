# Audio con pantalla apagada: estado de la comprobación

> Registro histórico de la herramienta diagnóstica y el reproductor básico anteriores. El estado actual del port 0.11.2 está en [su informe](pwa-port-0.11.2.md); ese port aún no tiene prueba física de pantalla apagada. Las tablas siguientes mantienen la evidencia original. Algunos artefactos citados pertenecen al entorno anterior y no están copiados a este worktree.

Actualizado el 18 de octubre de 2026. Prueba pública:
<https://diad87.github.io/pletina/prueba-audio/>.

La herramienta reproduce audio obtenido directamente desde el navegador. GitHub
Pages aloja sus archivos estáticos; no hay backend, proxy de música ni servidor
local en el teléfono. El reproductor completo de Pletina todavía no se ha portado.

## Evidencia disponible

| Entorno | Continuidad | Obtener y abrir siguiente fuente | Pantalla físicamente apagada |
| --- | --- | --- | --- |
| Chrome 148, Windows, pestaña oculta, siguiente resuelta al terminar | Audio avanza sin error | Resuelve y reproduce con `hidden: true` | No; prueba de escritorio |
| Chrome 148, Windows, pestaña oculta, siguiente preparada antes | Primera fuente funciona | Un fallo y una comprobación dirigida correcta; causa sin determinar | No; prueba de escritorio |
| Xiaomi 15T Pro, Chrome, pestaña, siguiente resuelta al terminar | Confirmado por el usuario | El audio vuelve a empezar según el usuario | Confirmado por el usuario en la prueba solicitada de dos minutos |
| Xiaomi 15T Pro, PWA integrada desde su icono | Confirmado por el usuario | Pasa a la siguiente según el usuario | Confirmado por el usuario en la prueba solicitada de dos minutos |
| iPhone físico, Safari y PWA desde su icono | Pendiente | Pendiente | No hay dispositivo disponible |

La ejecución pública de escritorio corresponde al build `8db30f4c37cea83c` y
está guardada en `artifacts/pwa-screen-off/desktop-background.json`. El runner es
`scripts/tests/pwa-screen-off.browser.mjs`. Adelanta la primera reproducción al
último segundo para verificar la transición; no equivale al protocolo físico de
dos minutos. Silencia la salida de Chrome mediante `--mute-audio`, manteniendo el
elemento multimedia con `muted: false`.

El modo de URL preparada obtuvo los metadatos de la primera fuente y resolvió la
segunda; al asignarla, el navegador emitió error multimedia 4 y rechazó `play()`
con `NotSupportedError`. Una comprobación posterior dirigida del mismo build
funcionó, con respuestas HTTP 206 y la segunda reproducción avanzando con la
pestaña oculta. La evidencia está en
`artifacts/pwa-screen-off/desktop-prepared-8db30f4c37cea83c-check.json`. No se ha
determinado la causa del fallo ni se ha aplicado una corrección que lo resuelva.
Ese fallo aislado de escritorio no se atribuye a una causa corregida. La primera
integración posterior del reproductor y sus pruebas están recogidas en
[su informe](pwa-player-results.md).

La fase inicial pasó **20/20** comprobaciones de compilación, versiones,
integridad, arranque sin red, actualización y aislamiento de cachés. La suite
actual `npm run test:pwa`, con la integración del reproductor bajo demanda, pasó
**33/33**. Estas pruebas automáticas no verifican el audio con pantalla apagada.

El build posterior `d4f9611d0b371a3e` añade `muted` y `volume` al diagnóstico y
verifica la integridad también si falta un archivo de caché. Mantiene el mismo
procedimiento de resolución y reproducción de los ensayos anteriores.

El 18 de octubre el usuario respondió **«Sigue sonando y vuelve a empezar»** al
protocolo de Chrome con pantalla apagada y resolución al terminar. Identificó el
dispositivo como **Xiaomi 15T Pro, desde Chrome**. Es una observación física
aportada por el usuario; no se ha recibido el JSON, la versión de Android/Chrome
ni la versión exacta del build abierto. Confirma esa ejecución concreta y da base
para continuar el reproductor web; esa primera observación se limita a la pestaña
de Chrome.

Después, el mismo día, el usuario respondió **«Funciona instalada y bloqueada»**
al protocolo del reproductor integrado: abrir desde el icono, reproducir la cola,
adelantar hasta 30 segundos antes del final y bloquear dos minutos para comprobar
continuidad y siguiente pista. Queda registrada esta segunda confirmación física
en `artifacts/pwa-screen-off/android-installed-user-confirmation.json`, para el
mismo Xiaomi 15T Pro identificado anteriormente. No se ha recibido un registro
automático ni la versión exacta instalada; el build indicado en la prueba era
`85d3cde632c1480f`. Confirma el uso instalado en ese teléfono; otros dispositivos,
iOS y las pruebas de mayor duración siguen sin validar.

## Protocolo y comprobaciones restantes

1. Abrir la dirección pública en Chrome con conexión.
2. Mantener los IDs de muestra y elegir **Resolver solo cuando termine la
   primera**. Pulsar **Preparar** y esperar a que habilite el inicio.
3. Pulsar **Empezar y bloquear**, comprobar que se oye y apagar la pantalla con
   el botón físico durante **dos minutos**. Pasados unos 30 segundos debe empezar
   la misma muestra desde el principio, obteniendo una nueva URL en ese momento.
4. Desbloquear, pulsar **Parar**, confirmar el apagado físico si corresponde y
   exportar el registro. Anotar modelo, versión de Android y Chrome, si se oyó
   sin interrupción y si volvió a empezar sin tocar el móvil.
5. La comprobación equivalente desde el icono de la PWA integrada ya fue
   confirmada por el usuario. Quedan como comprobaciones adicionales el modo
   **Preparada antes de bloquear**, una ejecución más larga de diez minutos y los
   contextos de iPhone cuando haya un dispositivo disponible.

El JSON se guarda y se exporta en el propio navegador. No se envía a ningún
servicio de telemetría y no contiene URLs de audio firmadas ni credenciales. El
estado `hidden` y la casilla manual se registran por separado; ninguno es una
medición automática del botón físico.

Android Auto y CarPlay quedan para una fase posterior. No se ha cambiado el
motor nativo ni se ha declarado compatibilidad móvil a partir del escritorio.
