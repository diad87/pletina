# Controles del pódcast en pantallas estrechas

La fila de controles intentaba mantener play, descarga, Guardar pódcast y Reproducir episodios en una sola línea. El navegador reducía el ancho del play sin reducir su altura: en la vista de 393 px medía aproximadamente 38,9 × 52 px.

El play principal ya no puede encogerse por flexbox. La fila del pódcast permite saltos de línea; Guardar pódcast conserva su texto en una línea y el mensaje Reproducir episodios ocupa la siguiente línea en móvil. Descarga tiene un área fija de 44 × 44 px con el icono centrado. El icono SVG original ya medía 30 × 30 px en la inspección; se conserva su proporción.

La inspección compara las distribuciones compiladas anterior y corregida, usando Firefox de escritorio con los proveedores HTTP sintéticos existentes. En anchos de 320, 360, 393 y 430 px el play corregido mide 52 × 52 px; en 768 y 1280 px mide 58 × 58 px. Descarga mide 44 × 44 en todos; no se observa desbordamiento horizontal. La captura corregida se revisó visualmente. No es una prueba en un teléfono físico ni una prueba de reproducción.

El intento inicial de localizar el programa real Búscate la vida no obtuvo la tarjeta esperada durante 45 segundos. Se conserva por separado como intento incompleto; no se cuenta como una comprobación del diseño ni se atribuye su causa al producto. La comparación controlada utiliza los mismos controles con un pódcast de YouTube de prueba.

[Mediciones y capturas](../artifacts/pwa-port/podcast-controls-a2e6b8da9fb17c07-visual.json). Compilación `a2e6b8da9fb17c07`, fuente `0f930563fb29b3f4d61c75ab09fbf135c1ee9882`; compilación y comprobación de tipos correctas, sin errores ni avisos.
