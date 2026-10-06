package dev.musify.desktop

import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // El botón "atrás" lo gestiona la interfaz (ver App.svelte), no el historial del WebView.
  override val handleBackNavigation: Boolean = false

  private var webView: WebView? = null

  /**
   * Zonas que ocupan la barra de estado y la de gestos (en px de CSS). El WebView de Android no las
   * da con env(safe-area-inset-*), así que la interfaz las lee de aquí (ver src/lib/layout.svelte.ts).
   */
  private val insets = object {
    @Volatile var top = 0f
    @Volatile var bottom = 0f

    @JavascriptInterface
    fun get(): String = "$top,$bottom"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val density = resources.displayMetrics.density
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      val bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      insets.top = bars.top / density
      insets.bottom = bars.bottom / density
      webView?.evaluateJavascript("window.dispatchEvent(new Event('musify-insets'))", null)
      ViewCompat.onApplyWindowInsets(view, windowInsets)
    }

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val view = webView
        if (view == null) {
          moveTaskToBack(true)
          return
        }
        // La interfaz cierra lo que haya abierto o vuelve atrás; si no le queda nada, la app pasa a
        // segundo plano (la música sigue sonando).
        view.evaluateJavascript("window.__musifyBack ? window.__musifyBack() : false") { handled ->
          if (handled != "true") moveTaskToBack(true)
        }
      }
    })
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.isVerticalScrollBarEnabled = false
    webView.isHorizontalScrollBarEnabled = false
    webView.addJavascriptInterface(insets, "MusifyInsets")
  }
}
