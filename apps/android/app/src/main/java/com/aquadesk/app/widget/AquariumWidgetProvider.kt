package com.aquadesk.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import com.aquadesk.app.R
import com.aquadesk.app.store.AuthStore
import com.aquadesk.app.web.WebAppActivity

/**
 * AquariumWidgetProvider — RemoteViews 위젯 (설계서/03 §7, §4.4).
 * [먹이][청소] 버튼 → QuickActionReceiver 브로드캐스트 → 서버 RPC(서버 권위).
 * 비로그인/토큰 만료: 버튼 비활성 + "앱에서 로그인" + 탭 시 앱 열기(딥링크 aquadesk://login).
 * 위젯은 실시간 애니 불가(§7) — 스냅샷 상태 텍스트 + 버튼 트리거만.
 */
class AquariumWidgetProvider : AppWidgetProvider() {

    companion object {
        /** 로그인 상태 변화(브리지 setAuth/clear·SyncWorker 폴백) 시 전체 위젯 갱신. */
        fun updateAll(ctx: Context) {
            val mgr = AppWidgetManager.getInstance(ctx)
            val ids = mgr.getAppWidgetIds(ComponentName(ctx, AquariumWidgetProvider::class.java))
            if (ids.isNotEmpty()) render(ctx, mgr, ids)
        }

        private fun render(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
            val loggedIn = AuthStore.load(ctx) != null
            ids.forEach { id ->
                val views = RemoteViews(ctx.packageName, R.layout.widget_aquarium)
                views.setTextViewText(
                    R.id.widget_status,
                    if (loggedIn) ctx.getString(R.string.widget_status_ready)
                    else ctx.getString(R.string.widget_status_login),
                )
                // ★버튼은 항상 enabled 유지: disabled View는 터치를 '소비만' 하고 PendingIntent를
                //   발사하지 않아 §4.4 '버튼 탭 → 앱 열기'가 무반응이 된다(리뷰 확정 결함).
                //   비활성 표현은 텍스트 색으로만 하고, 클릭 타깃을 앱 열기 인텐트로 교체한다.
                val textColor = if (loggedIn) 0xFF102A43.toInt() else 0xFF9AA5B1.toInt()
                views.setTextColor(R.id.btn_feed, textColor)
                views.setTextColor(R.id.btn_clean, textColor)

                if (loggedIn) {
                    views.setOnClickPendingIntent(
                        R.id.btn_feed, broadcast(ctx, QuickActionService.ACTION_FEED, 1),
                    )
                    views.setOnClickPendingIntent(
                        R.id.btn_clean, broadcast(ctx, QuickActionService.ACTION_CLEAN, 2),
                    )
                    views.setOnClickPendingIntent(R.id.widget_root, openApp(ctx, null))
                } else {
                    // §4.4: 비로그인 → RPC 대신 앱 열기(로그인 딥링크). optimistic 반영도 금지.
                    val open = openApp(ctx, "aquadesk://login")
                    views.setOnClickPendingIntent(R.id.btn_feed, open)
                    views.setOnClickPendingIntent(R.id.btn_clean, open)
                    views.setOnClickPendingIntent(R.id.widget_root, open)
                }
                mgr.updateAppWidget(id, views)
            }
        }

        private fun openApp(ctx: Context, deepLink: String?): PendingIntent =
            PendingIntent.getActivity(
                ctx, if (deepLink == null) 4 else 3,
                Intent(ctx, WebAppActivity::class.java).apply {
                    if (deepLink != null) data = android.net.Uri.parse(deepLink)
                    // singleTop(manifest)과 결합 — 기존 셸 재사용 + onNewIntent 딥링크 라우팅.
                    addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

        private fun broadcast(ctx: Context, action: String, code: Int): PendingIntent =
            PendingIntent.getBroadcast(
                ctx, code,
                Intent(ctx, QuickActionReceiver::class.java).setAction(action),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
    }

    override fun onUpdate(context: Context, mgr: AppWidgetManager, appWidgetIds: IntArray) {
        render(context, mgr, appWidgetIds)
    }
}
