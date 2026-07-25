package com.aquadesk.app.ipc

import android.content.Context
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper

/**
 * WallpaperBus — ContentObserver 래퍼 (설계서/03 §4.3, GUARDRAILS §9).
 * 캐시 변경 통지: 쓰는 쪽(notify) → CacheSignalProvider URI notifyChange →
 * 구독자(observe: WallpaperService Engine)가 캐시 reload + 연출 큐잉.
 */
object WallpaperBus {

    val SIGNAL_URI: Uri = Uri.parse("content://com.aquadesk.cache/snapshot")

    /** 캐시가 갱신됐음을 통지한다(브리지 applySnapshot / QuickAction / SyncWorker). */
    fun notify(ctx: Context) {
        ctx.contentResolver.notifyChange(SIGNAL_URI, null)
    }

    /** 구독 — 반환된 observer는 소유자가 unregister 책임(Engine.onDestroy). */
    fun observe(ctx: Context, cb: () -> Unit): ContentObserver {
        val obs = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) = cb()
        }
        ctx.contentResolver.registerContentObserver(SIGNAL_URI, false, obs)
        return obs
    }

    fun unobserve(ctx: Context, obs: ContentObserver) {
        ctx.contentResolver.unregisterContentObserver(obs)
    }
}
