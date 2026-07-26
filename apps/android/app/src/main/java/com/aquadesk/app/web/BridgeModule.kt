package com.aquadesk.app.web

import android.app.Activity
import android.app.WallpaperManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.webkit.JavascriptInterface
import com.aquadesk.app.ipc.WallpaperBus
import com.aquadesk.app.store.AuthStore
import com.aquadesk.app.store.LocalCacheStore
import com.aquadesk.app.sync.SyncWorker
import com.aquadesk.app.wallpaper.AquariumWallpaperService
import com.aquadesk.app.wallpaper.ShaderGate
import com.aquadesk.app.widget.AquariumWidgetProvider
import java.lang.ref.WeakReference

/**
 * BridgeModule — window.AquaDeskNative (@JavascriptInterface, 동기) (설계서/03 §8).
 * 웹의 Promise 기반 window.AquaDesk 계약(GUARDRAILS §5)은 WebAppActivity가 주입하는
 * JS 셔임이 이 동기 인터페이스를 감싸서 제공한다. 버전 협상: version() = BRIDGE_VERSION.
 *
 * ★서버 권위(GUARDRAILS §1): 이 브리지는 로컬 캐시/세션/인텐트만 다룬다.
 *   경제·수집 상태 변경은 전부 웹앱→서버 RPC 경유(네이티브가 직접 쓰지 않음).
 */
class BridgeModule(context: Context, activity: Activity?) {

    companion object {
        /** 네이티브가 보장하는 브리지 계약 버전(웹 WEB_REQUIRED_BRIDGE_VERSION과 협상). */
        const val BRIDGE_VERSION = 1
    }

    private val appContext = context.applicationContext
    private val activityRef = WeakReference(activity)

    @JavascriptInterface
    fun version(): Int = BRIDGE_VERSION

    /** 스냅샷 캐시 갱신 + 배경 통지. 반환 "ok" | "error:<code>". */
    @JavascriptInterface
    fun applySnapshot(json: String): String {
        return try {
            LocalCacheStore.saveRaw(appContext, json)
            WallpaperBus.notify(appContext)
            "ok"
        } catch (_: Exception) {
            "error:invalid_snapshot"
        }
    }

    /** 현재 캐시 스냅샷 JSON(없으면 기본 스냅샷). */
    @JavascriptInterface
    fun requestSnapshot(): String = LocalCacheStore.load(appContext).toJson()

    /** 배경 설정 화면 직행(ACTION_CHANGE_LIVE_WALLPAPER, 폴백 chooser — 설계서/03 §9.1). */
    @JavascriptInterface
    fun previewWallpaper() {
        val activity = activityRef.get() ?: return
        activity.runOnUiThread {
            val direct = Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER).apply {
                putExtra(
                    WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT,
                    ComponentName(activity, AquariumWallpaperService::class.java),
                )
            }
            try {
                activity.startActivity(direct)
            } catch (_: Exception) {
                // 제조사 미지원 폴백: 라이브 배경 chooser.
                try {
                    activity.startActivity(Intent(WallpaperManager.ACTION_LIVE_WALLPAPER_CHOOSER))
                } catch (_: Exception) {
                    // chooser마저 없으면 무시(웹이 안내 문구 표시).
                }
            }
        }
    }

    /** R8: 네이티브 보관 세션 읽기 — JSON 또는 "null". 웹은 독립 refresh 금지. */
    @JavascriptInterface
    fun getAuthSession(): String = AuthStore.load(appContext)?.toJson() ?: "null"

    /** R8: 웹 로그인 후 refresh token 위탁(Keystore 암호화 저장) → 즉시 1회 동기화 + 위젯 활성. */
    @JavascriptInterface
    fun setAuthSession(refreshToken: String): String {
        if (refreshToken.isBlank()) return "error:empty_token"
        val current = AuthStore.load(appContext)
        if (current?.refreshToken == refreshToken) {
            // 동일 토큰 재위탁(콜드스타트 승계 신호 등) — 보유 access를 지우지 않는다(리뷰 픽스).
            // 동기화는 트리거하되, 회전은 TokenRefresher가 access 만료 시에만 수행하므로 낭비 없음.
            SyncWorker.enqueueOnce(appContext)
            return "ok"
        }
        if (!AuthStore.save(appContext, refreshToken, null)) return "error:store_failed"
        SyncWorker.enqueueOnce(appContext)
        AquariumWidgetProvider.updateAll(appContext)
        return "ok"
    }

    @JavascriptInterface
    fun clearAuthSession() {
        AuthStore.clear(appContext)
        AquariumWidgetProvider.updateAll(appContext)
    }

    /** 셰이더 게이팅 절전 토글(설계서/03 §1 ShaderGate). */
    @JavascriptInterface
    fun setLowPower(on: Boolean) {
        ShaderGate.setLowPower(appContext, on)
        WallpaperBus.notify(appContext) // 렌더 정책 즉시 반영 유도
    }
}
