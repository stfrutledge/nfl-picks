package com.sfrut.nflpicks

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
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

    /** Pull down to retry: only while [banner] is up, so it never fights the page's own scrolling. */
    private lateinit var swipe: SwipeRefreshLayout

    /** The strip above the page saying it is offline, or could not be reached. */
    private lateinit var banner: TextView

    /** The page on screen came out of the cache, not from the site. */
    private var fromCache = false

    /** The current load has finished (and failed, if [fromCache] was the fallback). */
    private var pageReady = false

    /** Where a tapped notification asked to land, until the page can be told. */
    private var pendingOpen: Pair<String, Int>? = null

    private val network = object : ConnectivityManager.NetworkCallback() {
        override fun onLost(lost: Network) = runOnUiThread {
            if (!online()) showBanner(OFFLINE)
        }
        override fun onAvailable(available: Network) = runOnUiThread {
            // Back with the live page still on screen: nothing to redo.
            // Back over a cached copy: say so, and let them pull for the latest.
            if (banner.visibility != View.VISIBLE) return@runOnUiThread
            if (fromCache) showBanner(BACK_ONLINE) else hideBanner()
        }
    }

    private val pageRunner: (String, (String) -> Unit) -> Unit = { script, onResult ->
        web.evaluateJavascript(script) { onResult(it ?: "null") }
    }

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

    /**
     * Open Settings, handing it the page's Odds API credits line for the admin
     * tools, and the page's theme - the site's own toggle, which can differ
     * from the phone's - so Settings matches the page it opened from.
     */
    private fun openSettings() {
        val script = """
            ({ quota: window.appAdminInfo ? appAdminInfo() : '',
               theme: localStorage.getItem('theme') })
        """.trimIndent()
        web.evaluateJavascript(script) { json ->
            val page = runCatching { JSONTokener(json).nextValue() as? JSONObject }.getOrNull()
            val quota = page?.optString("quota").orEmpty()
            // The site's rule: its saved toggle, else the phone's setting.
            if (page != null) prefs.siteDark = when (page.optString("theme")) {
                "dark" -> true
                "light" -> false
                else -> null
            }
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
        swipe = SwipeRefreshLayout(this).apply {
            addView(web, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            // Only from the very top of the page.
            setOnChildScrollUpCallback { _, _ -> web.scrollY > 0 }
            setOnRefreshListener { load() }
            isEnabled = false
        }
        banner = TextView(this).apply {
            val dp = { v: Float -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt() }
            setBackgroundColor(0xFFB45309.toInt())
            setTextColor(0xFFFFFFFF.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            gravity = Gravity.CENTER
            setPadding(dp(16f), dp(10f), dp(16f), dp(10f))
            visibility = View.GONE
            setOnClickListener { swipe.isRefreshing = true; load() }
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(banner, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(swipe, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        })
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(network)

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
        takeOpenRequest(intent)

        // Nobody chosen yet: that is the first question.
        if (prefs.picker == null) settings.launch(Intent(this, SettingsActivity::class.java))
        else askForNotifications()
    }

    /** A notification tapped while the app was already open (singleTask). */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takeOpenRequest(intent)
    }

    /**
     * Where a tapped notification should land, by its category: results on
     * the Blazin' 5 standings, a reminder on Make Picks for its week. The page
     * does the switching (openFromApp in app.js); a page too old to have it
     * just stays where it is.
     */
    private fun takeOpenRequest(intent: Intent?) {
        val category = intent?.getStringExtra(EXTRA_OPEN) ?: return
        intent.removeExtra(EXTRA_OPEN)
        val target = when (category) {
            Category.BLAZIN_RESULTS.id -> "standings-blazin"
            Category.PICK_REMINDERS.id -> "make-picks"
            else -> return
        }
        pendingOpen = target to (intent.getStringExtra(EXTRA_WEEK)?.toIntOrNull() ?: 0)
        if (pageReady) runOpenRequest()
    }

    private fun runOpenRequest() {
        val (target, week) = pendingOpen ?: return
        pendingOpen = null
        web.evaluateJavascript("window.openFromApp && openFromApp('$target', $week)", null)
    }

    private fun online(): Boolean {
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun showBanner(text: String) {
        banner.text = text
        banner.visibility = View.VISIBLE
        swipe.isEnabled = true
    }

    private fun hideBanner() {
        banner.visibility = View.GONE
        swipe.isRefreshing = false
        swipe.isEnabled = false
    }

    /**
     * The last page that loaded, out of the WebView's cache - its scripts and
     * styles too - with the site's own saved data (picks, schedule, lines in
     * localStorage) drawing it as it was. Nothing cached yet: say so plainly.
     */
    private fun loadFromCache(text: String) {
        fromCache = true
        pageReady = false
        showBanner(text)
        val last = prefs.lastPageUrl
        if (last == null) {
            showNothingSaved()
            return
        }
        web.settings.cacheMode = WebSettings.LOAD_CACHE_ELSE_NETWORK
        web.loadUrl(last)
    }

    private fun showNothingSaved() {
        showBanner(NOTHING_SAVED)
        web.loadDataWithBaseURL(null,
            "<html><body style=\"font-family:sans-serif;text-align:center;padding:64px 24px;color:#555\">" +
                "<h2>No connection</h2><p>Pull down to try again.</p></body></html>",
            "text/html", "utf-8", null)
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
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(network) }
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    private fun load() {
        loadedPicker = prefs.picker
        pageReady = false
        if (!online()) {
            loadFromCache(OFFLINE)
            return
        }
        fromCache = false
        web.settings.cacheMode = WebSettings.LOAD_DEFAULT
        // A unique query makes this a fresh fetch of the front page: GitHub
        // Pages lets it be cached for 10 minutes, and a cached copy runs the
        // site from before the last push. The scripts and styles it loads are
        // named by content hash, so they still come from the cache. The site
        // reads no query string.
        web.loadUrl("$SITE_URL?app=${System.currentTimeMillis()}")
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
            mainFrameFailed = false
        }

        /** Whether the page now loading failed, so finishing it does not count. */
        private var mainFrameFailed = false

        override fun onPageFinished(view: WebView, url: String?) {
            if (mainFrameFailed || url == null || url.startsWith("data:") || url == "about:blank") return
            pageReady = true
            swipe.isRefreshing = false
            if (!fromCache) {
                // A good load: the one an offline start reopens.
                prefs.lastPageUrl = url
                hideBanner()
            }
            runOpenRequest()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) fallBack(view)
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && response.statusCode >= 500) fallBack(view)
        }

        /**
         * The site did not load. Live, that is the site being down or the
         * connection lying about being up: fall back to the last copy. From the
         * cache, there was nothing cached to show.
         */
        private fun fallBack(view: WebView) {
            mainFrameFailed = true
            swipe.isRefreshing = false
            if (!fromCache) view.post { loadFromCache(if (online()) UNREACHABLE else OFFLINE) }
            else view.post { showNothingSaved() }
        }
    }

    companion object {
        /** On a notification's tap: its category, and the week it is about. */
        const val EXTRA_OPEN = "open"
        const val EXTRA_WEEK = "week"

        private const val OFFLINE = "The site is offline. Showing your last load. Pull down to retry."
        private const val UNREACHABLE = "Can’t reach the site. Showing your last load. Pull down to retry."
        private const val BACK_ONLINE = "Back online. Pull down to load the latest."
        private const val NOTHING_SAVED = "The site is offline. Pull down to retry."

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
