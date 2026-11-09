package com.sfrut.nflpicks

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * One NFL highlights video, for the site's spoiler-free highlights (1.19+).
 *
 * The NFL blocks its videos from YouTube's embedded player on other sites and
 * apps, so this shows YouTube's own mobile page for the video instead, with
 * everything but the player hidden: the suggested videos, the comments and
 * the end screen all name results ("4 INT in a win is crazy work" was the top
 * comment on the first one tried). The hiding is CSS on YouTube's page and can
 * break when YouTube changes it; two guards don't depend on it:
 *  - the video ending closes this screen, before any end screen;
 *  - the page moving to any other video (autoplay, a tapped link) closes it too.
 *
 * Closing hands back [EXTRA_ENDED]: whether the video played to the end.
 */
class HighlightsActivity : ComponentActivity() {

    private lateinit var web: WebView
    private lateinit var videoId: String
    private var finishing = false

    private var fullScreenView: View? = null
    private var fullScreenDone: WebChromeClient.CustomViewCallback? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        videoId = intent.getStringExtra(EXTRA_VIDEO)?.takeIf { isVideoId(it) } ?: run { finish(); return }

        web = WebView(this).apply { setBackgroundColor(Color.BLACK) }
        setContentView(FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        })

        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.addJavascriptInterface(Bridge(), "NFLHighlights")
        web.webViewClient = Client()
        web.webChromeClient = FullScreenVideo()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, PAGE_SCRIPT, YOUTUBE_ORIGINS)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (fullScreenView != null) fullScreenDone?.onCustomViewHidden() else done(false)
            }
        })

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else web.loadUrl("https://m.youtube.com/watch?v=$videoId")
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.saveState(outState)
    }

    override fun onDestroy() {
        if (::web.isInitialized) {
            web.stopLoading()
            web.destroy()
        }
        super.onDestroy()
    }

    private fun done(ended: Boolean) {
        if (finishing) return
        finishing = true
        web.evaluateJavascript("document.querySelector('video') && document.querySelector('video').pause()", null)
        setResult(RESULT_OK, Intent().putExtra(EXTRA_ENDED, ended))
        finish()
    }

    /** Is this URL still our video (or YouTube's cookie consent on the way to it)? */
    private fun stillOurs(url: String?): Boolean? {
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return null
        val host = uri.host ?: return null
        if (host == "consent.youtube.com" || host.endsWith(".google.com")) return true
        if (host != "m.youtube.com" && host != "www.youtube.com" && host != "youtube.com") return false
        return uri.path == "/watch" && uri.getQueryParameter("v") == videoId
    }

    private inner class Bridge {
        /** The page's video ended (not an ad). */
        @JavascriptInterface
        fun ended() = runOnUiThread { done(true) }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            return when (stillOurs(request.url.toString())) {
                true -> false
                // Anywhere else on YouTube (another video, a channel): this screen is done.
                false -> { done(false); true }
                null -> true
            }
        }

        // YouTube moves between videos without loading a page (autoplay, a
        // tapped suggestion): the address changing is the sign.
        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            if (stillOurs(url) == false) {
                val uri = Uri.parse(url)
                done(uri.path == "/watch")
            }
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) view.evaluateJavascript(PAGE_SCRIPT, null)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            // Again once loaded, for a WebView without document-start scripts.
            view.evaluateJavascript(PAGE_SCRIPT, null)
        }
    }

    /** YouTube's full-screen button: the video over everything, sideways, bars hidden. */
    private inner class FullScreenVideo : WebChromeClient() {
        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (fullScreenView != null) { callback.onCustomViewHidden(); return }
            fullScreenView = view
            fullScreenDone = callback
            (window.decorView as ViewGroup).addView(view, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            WindowCompat.getInsetsController(window, window.decorView).apply {
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                hide(WindowInsetsCompat.Type.systemBars())
            }
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        }

        override fun onHideCustomView() {
            val view = fullScreenView ?: return
            (window.decorView as ViewGroup).removeView(view)
            fullScreenView = null
            fullScreenDone = null
            WindowCompat.getInsetsController(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    companion object {
        const val EXTRA_VIDEO = "video"
        const val EXTRA_ENDED = "ended"

        private val YOUTUBE_ORIGINS = setOf("https://m.youtube.com", "https://www.youtube.com")

        fun isVideoId(id: String) = Regex("[A-Za-z0-9_-]{6,20}").matches(id)

        /**
         * Hide everything on YouTube's watch page but the player, and tell us
         * when the video (not an ad before it) ends. Checked on a timer
         * because YouTube builds its page, and swaps the video element, after
         * load.
         */
        private val PAGE_SCRIPT = """
            (function () {
              if (window.__nflHighlights) return;
              window.__nflHighlights = true;
              var css = [
                'ytm-mobile-topbar-renderer, #header-bar, ytm-pivot-bar-renderer,',
                'ytm-single-column-watch-next-results-renderer, ytm-watch-metadata-app-promo-renderer,',
                'ytm-item-section-renderer, ytm-comments-entry-point-header-renderer, ytm-engagement-panel,',
                '.related-chips-slot-wrapper, ytm-companion-slot, ytm-promoted-sparkles-web-renderer,',
                '.ytp-endscreen-content, .ytp-ce-element, .ytp-pause-overlay, .ytp-autonav-endscreen,',
                '.ytm-autonav-bar, .ytp-suggested-action, .ytp-cards-teaser, .ytp-videowall-still,',
                '.ytp-autonav-toggle-button-container, ytm-autonav-toggle-button-container,',
                '.ytmAutonavToggleButtonContainer, .ytp-fullerscreen-edu-button',
                '{ display: none !important; }',
                'html, body, ytm-app, #app { background: #000 !important; }'
              ].join('\n');
              function style() {
                if (document.getElementById('nfl-highlights-style')) return;
                var s = document.createElement('style');
                s.id = 'nfl-highlights-style';
                s.textContent = css;
                (document.head || document.documentElement).appendChild(s);
              }
              function hook() {
                style();
                var v = document.querySelector('video');
                if (!v || v.__nflHighlights) return;
                v.__nflHighlights = true;
                v.addEventListener('ended', function () {
                  var p = document.querySelector('.html5-video-player');
                  if (p && /ad-showing|ad-interrupting/.test(p.className)) return;
                  if (window.NFLHighlights) NFLHighlights.ended();
                });
              }
              style();
              setInterval(hook, 400);
            })();
        """.trimIndent()
    }
}
