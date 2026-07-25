package com.aquadesk.app.wallpaper

import android.content.Context

/**
 * ShaderGate — 기기 상태 → FPS/셰이더 정책 (설계서/03 §1, 기획서 04 §2.4).
 * 게이팅: 화면 OFF/비가시 = 0fps · 미터치 idle = 15fps · 터치 직후 = 30fps ·
 * 절전(lowPower) = 8fps + 포스트 패스 OFF. 상시 셰이더는 배터리 직격 — 필수 정책.
 */
object ShaderGate {

    private const val PREFS = "aquadesk_settings"
    private const val PREF_LOW_POWER = "low_power"
    private const val TOUCH_BOOST_MS = 4_000L

    fun setLowPower(ctx: Context, on: Boolean) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(PREF_LOW_POWER, on).apply()
    }

    fun isLowPower(ctx: Context): Boolean =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(PREF_LOW_POWER, false)

    /** 목표 FPS. 0 = 렌더 스레드 정지(가시성 게이트는 호출부에서 이미 판정). */
    fun targetFps(ctx: Context, visible: Boolean, lastTouchAt: Long, now: Long): Int {
        if (!visible) return 0
        if (isLowPower(ctx)) return 8
        return if (now - lastTouchAt < TOUCH_BOOST_MS) 30 else 15
    }

    /** 포스트 처리(오버레이/글로우) 허용 여부 — 절전이면 끈다. */
    fun postFxEnabled(ctx: Context): Boolean = !isLowPower(ctx)
}
