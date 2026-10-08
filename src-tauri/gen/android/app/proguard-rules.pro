# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# --- Musify -------------------------------------------------------------------------------------
# Lo que se busca por su nombre y no desde Kotlin, así que R8 no debe quitarlo ni renombrarlo:
# las funciones nativas de Rust (JNI: Java_dev_musify_desktop_MusifyCore_*), el plugin del
# reproductor (Tauri lo carga por nombre) y lo que la interfaz llama desde JavaScript.
-keep class dev.musify.desktop.MusifyCore { *; }
-keep @app.tauri.annotation.TauriPlugin class dev.musify.desktop.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
# Trazas de errores legibles en files/fase0.log.
-keepattributes SourceFile,LineNumberTable
