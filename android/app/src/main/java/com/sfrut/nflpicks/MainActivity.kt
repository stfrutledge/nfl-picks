package com.sfrut.nflpicks

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONTokener

/**
 * The live site, full screen. Everything the group sees is the site itself,
 * loaded from GitHub Pages, so a fix to the site reaches the app with no new
 * APK. The app adds only what a web page cannot do: a picker that belongs to
 * the phone, push notifications, and a clipboard that works.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private lateinit var prefs: Prefs

    private val pageRunner: (String) -> Unit = { script -> web.evaluateJavascript(script, null) }

    /** The picker the page was loaded with, to tell when Settings changed it. */
    private var loadedPicker: String? = null

    private val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /**
     * Settings, which may come back asking for one of the site's admin actions
     * (Refresh Spreads, Export All Picks). Those stay the site's own code: the
     * page is asked to run them, so they behave and report exactly as the
     * buttons do in a browser.
     */
    private val settings =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val action = result.data?.getStringExtra(SettingsActivity.EXTRA_ADMIN_ACTION)
                ?.takeIf { it in SettingsActivity.ADMIN_ACTIONS } ?: return@registerForActivityResult
            web.evaluateJavascript("window.runAppAdminAction && runAppAdminAction('$action')", null)
        }

    /** Open Settings, handing it the page's Odds API credits line for the admin tools. */
    private fun openSettings() {
        web.evaluateJavascript("window.appAdminInfo ? appAdminInfo() : ''") { json ->
            val quota = runCatching { JSONTokener(json).nextValue() as? String }.getOrNull().orEmpty()
            settings.launch(
                Intent(this, SettingsActivity::class.java).putExtra(SettingsActivity.EXTRA_QUOTA, quota)
            )
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)

        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.addJavascriptInterface(Bridge(), "NFLPicksApp")
        // Admin Settings runs the site's admin actions on this page, behind it.
        PageBridge.runScript = pageRunner
        web.webViewClient = SiteClient()

        // Before any of the site's own script runs: hand it this phone's
        // picker, and give it a clipboard. The site reads `selectedPicker` as
        // it loads, so setting it here is all it takes for the page to open as
        // the right person - the site needs no change to know about the app.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, START_SCRIPT, setOf(SITE_ORIGIN))
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else load()

        // Nobody chosen yet: that is the first question.
        if (prefs.picker == null) settings.launch(Intent(this, SettingsActivity::class.java))
        else askForNotifications()
    }

    override fun onResume() {
        super.onResume()
        // Back from Settings with a different picker: reload as them.
        if (prefs.picker != loadedPicker && prefs.picker != null) {
            load()
            askForNotifications()
        }
    }

    override fun onDestroy() {
        // Only our own: a recreated activity may already have lent a new one.
        if (PageBridge.runScript === pageRunner) PageBridge.runScript = null
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    private fun load() {
        loadedPicker = prefs.picker
        web.loadUrl(SITE_URL)
    }

    private fun askForNotifications() {
        if (!NflPicksApp.pushConfigured || Build.VERSION.SDK_INT < 33) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /** What the page can call, as window.NFLPicksApp. Runs on a binder thread. */
    inner class Bridge {
        @JavascriptInterface
        fun picker(): String = prefs.picker ?: ""

        @JavascriptInterface
        fun copy(text: String) = runOnUiThread {
            getSystemService(ClipboardManager::class.java)
                .setPrimaryClip(ClipData.newPlainText("NFL Picks", text))
        }

        @JavascriptInterface
        fun openSettings() = runOnUiThread { this@MainActivity.openSettings() }

        /** Tells the page that Settings has the admin actions, so it can drop its own buttons. */
        @JavascriptInterface
        fun hasAdminTools(): Boolean = true

        /** The page's answer to an admin action Admin Settings asked it to run. */
        @JavascriptInterface
        fun adminResult(action: String, ok: Boolean, message: String, quota: String) = runOnUiThread {
            PageBridge.onAdminResult?.invoke(AdminResult(action, ok, message, quota))
        }
    }

    private inner class SiteClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (url.host == SITE_HOST && url.path.orEmpty().startsWith("/nfl-picks")) return false
            // Anything else - the backup sheet, a WhatsApp link - belongs in
            // its own app, not inside this one.
            return try {
                startActivity(Intent(Intent.ACTION_VIEW, url))
                true
            } catch (e: Exception) {
                false
            }
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            // A WebView too old for document-start scripts: run it now. It can
            // lose the race with the site's own script, which then shows its
            // picker dropdown as before - the only cost.
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                view.evaluateJavascript(START_SCRIPT, null)
            }
        }
    }

    companion object {
        private val SITE_HOST = Uri.parse(SITE_URL).host
        private val SITE_ORIGIN = "https://$SITE_HOST"

        private val START_SCRIPT = """
            (function () {
                if (!window.NFLPicksApp) return;
                try {
                    var picker = NFLPicksApp.picker();
                    if (picker) localStorage.setItem('selectedPicker', picker);
                } catch (e) {}
                // The async Clipboard API is not reliable in a WebView, and the
                // site copies through it (Export All Picks, the recap).
                var write = function (text) { NFLPicksApp.copy(String(text)); return Promise.resolve(); };
                try {
                    if (navigator.clipboard) navigator.clipboard.writeText = write;
                    else Object.defineProperty(navigator, 'clipboard', { value: { writeText: write } });
                } catch (e) {}
            })();
        """.trimIndent()
    }
}
