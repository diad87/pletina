# Bienvenida e instalación de Pletina

La versión `cc8c27ed537f3353` cambia únicamente la portada de bienvenida e instalación. Usa el diseño Esencial oscuro, el disco y la funda, el titular «Dale al play.» y el mensaje «Encuentra lo que te mueve. Guárdalo en tus listas. Llévalo contigo.». Conserva el logo pequeño en la cabecera, las guías de instalación y las acciones «Instalar Pletina» y «Probar sin instalar».

Al abrirla desde el icono instalado, entra directamente en la aplicación actual, incluso en la primera apertura y sin una marca previa de localStorage. La portada se oculta antes de pintar. También entra directamente cuando el navegador notifica `appinstalled`; si falla la descarga, muestra un reintento explícito sin bucles ni activación automática de una actualización pendiente. Una visita normal desde el navegador conserva la bienvenida: no se presupone una instalación que el navegador no comunica.

Los **17 archivos de `application/` son idénticos byte a byte** a la publicación anterior `e6e79b96d898769a`: no cambia la interfaz interior, el modo coche, los reproductores ni la biblioteca. El manifiesto mantiene identidad, URL de inicio, ámbito e iconos; actualiza únicamente descripción y colores. La tipografía de la bienvenida está incluida en el HTML y la primera visita no descarga ni guarda la aplicación hasta abrirla.

Validación local: **994/994 pruebas de lógica**, tipos con **0 errores y 0 avisos**, compilación correcta y **8/8 recorridos de navegador** sin errores. Incluyen tamaños 320 × 568, 320 × 844, 390 × 844, 844 × 390 y 1280 × 900; contraste, controles de al menos 44 px, guías Android/iPhone, prompt controlado, apertura automática y copia portátil. La actualización real del service worker desde e6e conserva una playlist creada desde la UI, sus entradas duplicadas, favoritos y una cola pausada a los 37 segundos, también después de recargar sin red. Los metadatos de esa comprobación son fixtures declarados; no se afirma reproducción con un proveedor real ni dispositivos móviles físicos.

- [Informe local y capturas](../artifacts/pwa-e2e/welcome-cc8c27ed537f3353/summary.json).
- [Comparación de la aplicación existente](../artifacts/pwa-e2e/welcome-cc8c27ed537f3353/application-unchanged.json).
- [33/33 archivos públicos verificados por HTTP y SHA-256](../artifacts/pwa-deploy/public-files-cc8c27ed537f3353.json).
- [Despliegue correcto](https://github.com/diad87/pletina/actions/runs/40130223056).

La instalación pública mediante CDP en un perfil desechable de Chrome pasa **6/6** comprobaciones: apertura standalone sin pulsar un botón de bienvenida, reinicio del navegador, conservación de almacenamiento, recarga sin red y limpieza de la instalación de QA. [Informe y alcance](../artifacts/pwa-e2e/welcome-cc8c27ed537f3353/public-installed.json). No verifica el diálogo nativo de confirmación ni un teléfono físico.

El [canario público de bienvenida](../artifacts/pwa-e2e/welcome-cc8c27ed537f3353/public-welcome.json) pasa **3/3**: versión publicada, diseño aprobado a 390 × 844 y guía de Android. No abre el reproductor ni consulta catálogo o audio; confirma que la portada no descarga la aplicación. [Resumen de publicación](../artifacts/pwa-port/welcome-release-cc8c27ed537f3353.json).

Publicación: [Pletina](https://diad87.github.io/pletina/), fuente `913799e8446dbe3b72df96b0b78b8644f6a52aeb`, rama `codex/pwa-0-11-2-port`, commit de Pages `5c5578898effcf09c564956ca42c05fac82673f3`. Distribución: **33 archivos, 1.006.287 bytes**, entrada mínima **99.327** y aplicación bajo demanda **861.387**. No hace falta reinstalar: se puede aplicar la actualización desde el aviso de la app o cerrar Pletina y usar «Actualizar y abrir» en la portada.
