package com.aquadesk.app.widget

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.aquadesk.app.ipc.WallpaperBus
import com.aquadesk.app.model.PendingAnim
import com.aquadesk.app.net.SupabaseHttp
import com.aquadesk.app.store.AuthStore
import com.aquadesk.app.store.LocalCacheStore
import com.aquadesk.app.sync.SyncWorker
import com.aquadesk.app.sync.TokenRefresher
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * QuickAction — 위젯/알림 액션 → 서버 RPC(feed_fish/clean_aquarium) (설계서/03 §4.2).
 *
 * 트리거는 BroadcastReceiver다: Android 8+에서 위젯 PendingIntent로 백그라운드
 * startService가 제한되므로 getBroadcast + goAsync가 신뢰 가능한 경로다.
 * (GUARDRAILS §3 명명 준수 — 로직 모듈명은 QuickActionService, ❌BackgroundService.)
 *
 * 서버 권위(§1): 상태 변경은 RPC만. optimistic 캐시 반영은 표시용이며,
 * 성공/충돌 후 SyncWorker 1회로 권위 스냅샷에 수렴한다.
 */
object QuickActionService {

    const val ACTION_FEED = "com.aquadesk.app.action.FEED"
    const val ACTION_CLEAN = "com.aquadesk.app.action.CLEAN"

    /**
     * 위젯 버튼 액션 처리(§4.2 흐름 0→1→2→3). 워커 스레드에서 호출된다.
     * 시간 예산: SupabaseHttp 타임아웃 6s × 최악 3왕복(rpc→refresh→rpc) = 36s
     * < 백그라운드 브로드캐스트 데드라인(약 60s). 크래시 금지 — 전 경로 예외 없이 종료.
     */
    fun handle(ctx: Context, action: String) {
        // 0) 토큰 확인 — 비로그인/만료면 §4.4(위젯 비활성 + 앱 유도)로 종료.
        if (AuthStore.load(ctx) == null) {
            AquariumWidgetProvider.updateAll(ctx)
            return
        }
        val aquariumId = SyncWorker.savedAquariumId(ctx) ?: run {
            // 아직 첫 동기화 전 — 어항 id를 모른다 → 동기화만 트리거.
            SyncWorker.enqueueOnce(ctx)
            return
        }

        val rpcName = if (action == ACTION_CLEAN) "clean_aquarium" else "feed_fish"
        val args = JSONObject().put("aquarium_id", aquariumId)

        // 1) 유효 access 확보(회전은 TokenRefresher 전역 임계구역 — R8) → 서버 RPC.
        var access = when (val a = TokenRefresher.ensureAccess(ctx)) {
            is TokenRefresher.Access.Ok -> a.token
            else -> return // NoSession/Invalid는 Refresher가 위젯 갱신까지 처리, Transient는 포기.
        }
        var res = SupabaseHttp.rpc(rpcName, args, access)
        if (res != null && res.status == 401) {
            // 서버가 명시적으로 만료 판정 → 강제 회전 후 1회 재시도.
            // (res == null 네트워크 오류에는 refresh를 소모하지 않는다 — 리뷰 픽스.)
            access = when (val a = TokenRefresher.ensureAccess(ctx, force = true)) {
                is TokenRefresher.Access.Ok -> a.token
                else -> return
            }
            res = SupabaseHttp.rpc(rpcName, args, access)
        }
        val body = res?.takeIf { it.ok }?.body ?: run {
            // 네트워크/서버 오류 — optimistic 반영 없이 재동기화만(권위 위반 방지).
            SyncWorker.enqueueOnce(ctx)
            return
        }

        val status = try { JSONObject(body).optString("status") } catch (_: Exception) { "" }
        if (status == "ok") {
            // 2) optimistic 캐시 반영 + pendingAnims — 원자 update(동시 SyncWorker 저장과
            //    낡은 기반 덮어쓰기 레이스 방지). 배경이 가려져 있으면 Engine이 큐잉(R1).
            val anim = PendingAnim(
                kind = if (action == ACTION_CLEAN) "clean" else "feed-drop",
                at = System.currentTimeMillis(),
            )
            LocalCacheStore.update(ctx) { cached ->
                cached.copy(
                    waterQuality = if (action == ACTION_CLEAN) 1f else cached.waterQuality,
                    fish = cached.fish.map { it.copy(satisfied = true) },
                    pendingAnims = listOf(anim),
                )
            }
            // 3) 배경 통지(ContentObserver) + 권위 재동기화.
            WallpaperBus.notify(ctx)
        }
        // conflict(version CAS 불일치) 포함 — 서버 스냅샷 강제 refresh(§10 conflict 처리).
        SyncWorker.enqueueOnce(ctx)
    }
}

/** 위젯 PendingIntent 수신부 — goAsync + 워커 스레드로 RPC 왕복(10s 창 내 완료). */
class QuickActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != QuickActionService.ACTION_FEED && action != QuickActionService.ACTION_CLEAN) return
        val pending = goAsync()
        thread(name = "AquaQuickAction") {
            try {
                QuickActionService.handle(context.applicationContext, action)
            } finally {
                pending.finish()
            }
        }
    }
}
