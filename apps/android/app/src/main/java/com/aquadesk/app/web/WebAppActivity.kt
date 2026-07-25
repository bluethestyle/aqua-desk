package com.aquadesk.app.web

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

/**
 * WebAppActivity — Fullscreen WebView 셸 (설계서/03 §8).
 *  - UA에 'AquaDesk-Android' 부여 → 웹 middleware가 네이티브 모드 감지.
 *  - AquaDeskNative(@JavascriptInterface, 동기) + JS 셔임 주입 → window.AquaDesk(Promise 계약).
 *  - 딥링크: aquadesk://sync-complete | aquarium/{token} | login (GUARDRAILS §5).
 */
class WebAppActivity : AppCompatActivity() {

    companion object {
        /** 웹앱 URL — 하이브리드의 원격 UI(Vercel). 로컬 개발 시 인텐트 extra로 오버라이드. */
        const val DEFAULT_WEB_URL = "https://aqua-desk-web.vercel.app"
        const val EXTRA_WEB_URL = "web_url"
        private const val UA_TOKEN = " AquaDesk-Android/1"
    }

    private lateinit var webView: WebView

    /** window.AquaDesk Promise 셔임 — AquaDeskNative(동기)를 계약(GUARDRAILS §5)으로 감싼다. */
    private val bridgeShim = """
        (function () {
          if (window.AquaDesk || !window.AquaDeskNative) return;
          var N = window.AquaDeskNative;
          function okOrReject(r) {
            return r === 'ok' ? Promise.resolve() : Promise.reject(new Error(r || 'bridge_error'));
          }
          window.AquaDesk = {
            minBridgeVersion: N.version(),
            applySnapshot: function (s) {
              try { return okOrReject(N.applySnapshot(JSON.stringify(s))); }
              catch (e) { return Promise.reject(e); }
            },
            requestSnapshot: function () {
              try { return Promise.resolve(JSON.parse(N.requestSnapshot())); }
              catch (e) { return Promise.reject(e); }
            },
            previewWallpaper: function () { N.previewWallpaper(); },
            getAuthSession: function () {
              try { return Promise.resolve(JSON.parse(N.getAuthSession() || 'null')); }
              catch (e) { return Promise.reject(e); }
            },
            setAuthSession: function (t) {
              try { return okOrReject(N.setAuthSession(String(t))); }
              catch (e) { return Promise.reject(e); }
            },
            clearAuthSession: function () { N.clearAuthSession(); },
            setLowPower: function (on) { N.setLowPower(!!on); },
          };
        })();
    """.trimIndent()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // supabase-js 세션(localStorage) 필수
            userAgentString += UA_TOKEN
        }
        webView.addJavascriptInterface(BridgeModule(this, this), "AquaDeskNative")
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                // 문서 시작 시점에 셔임 주입 — 웹 코드는 호출 시점에 window.AquaDesk 존재를 확인한다.
                view.evaluateJavascript(bridgeShim, null)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                view.evaluateJavascript(bridgeShim, null) // 이중 주입 안전(멱등 가드)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                // 딥링크는 네이티브 라우팅, 그 외 http(s)는 웹뷰 내 탐색.
                if (uri.scheme == "aquadesk") {
                    handleDeepLink(uri)
                    return true
                }
                return false
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        val fromDeepLink = intent?.data
        if (fromDeepLink?.scheme == "aquadesk") {
            loadForDeepLink(fromDeepLink)
        } else {
            webView.loadUrl(intent?.getStringExtra(EXTRA_WEB_URL) ?: DEFAULT_WEB_URL)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.takeIf { it.scheme == "aquadesk" }?.let { handleDeepLink(it) }
    }

    /** aquadesk:// 라우팅(GUARDRAILS §5): sync-complete / aquarium/{token} / login. */
    private fun handleDeepLink(uri: Uri) {
        loadForDeepLink(uri)
    }

    private fun loadForDeepLink(uri: Uri) {
        val base = intent?.getStringExtra(EXTRA_WEB_URL) ?: DEFAULT_WEB_URL
        when (uri.host) {
            "aquarium" -> {
                // aquadesk://aquarium/{token} — 공유 뷰어(불투명 토큰만, user_id 금지 §1.3).
                val token = uri.pathSegments.firstOrNull()
                webView.loadUrl(if (token != null) "$base/aquarium/$token" else base)
            }
            "login" -> webView.loadUrl("$base/account")
            // sync-complete 등 — 웹 리로드 없이 배경만 갱신되는 신호라 현재 페이지 유지.
            else -> if (webView.url == null) webView.loadUrl(base)
        }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
