package com.aquadesk.app.sync

import android.content.Context
import android.util.Base64
import com.aquadesk.app.net.SupabaseHttp
import com.aquadesk.app.store.AuthStore
import com.aquadesk.app.widget.AquariumWidgetProvider
import org.json.JSONObject

/**
 * TokenRefresher — refresh 회전의 **프로세스 전역 임계구역** (R8 단일 주체의 실체).
 *
 * SyncWorker(주기/일회)·QuickAction(위젯 탭)·BridgeModule이 각자 refresh하면
 * read-rotate-write 레이스로 유효 토큰이 유실된다(리뷰 확정 결함). 모든 access 확보는
 * 반드시 이 @Synchronized 진입점을 거친다:
 *  - access가 아직 유효(만료 60s+ 전)하면 회전하지 않고 재사용 → 불필요 회전 제거.
 *  - Invalid(400~403)면 compare-and-clear — '내가 쓴 토큰'이 그대로일 때만 파기.
 */
object TokenRefresher {

    sealed class Access {
        data class Ok(val token: String) : Access()
        object NoSession : Access()
        /** refresh 무효 — 토큰 파기됨(재인증 유도, §6.1 폴백). */
        object Invalid : Access()
        /** 네트워크/일시 오류 — 회전 미발생, 재시도 대상. */
        object Transient : Access()
    }

    /** JWT exp(ms). 파싱 실패 = 0(만료 취급). */
    private fun jwtExpMs(token: String): Long = try {
        val payload = token.split(".")[1]
        val json = String(
            Base64.decode(payload, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP),
            Charsets.UTF_8,
        )
        JSONObject(json).optLong("exp", 0L) * 1000
    } catch (_: Exception) {
        0L
    }

    /**
     * 유효 access token 확보. force=true(401 직후)면 만료 판정을 건너뛰고 회전한다.
     * 프로세스 전역 직렬화 — 동시 호출자는 순차 처리되고 두 번째는 첫 회전 결과를 재사용한다.
     */
    @Synchronized
    fun ensureAccess(ctx: Context, force: Boolean = false): Access {
        val session = AuthStore.load(ctx) ?: return Access.NoSession

        if (!force) {
            val access = session.accessToken
            if (access != null && jwtExpMs(access) > System.currentTimeMillis() + 60_000) {
                return Access.Ok(access)
            }
        }

        return when (val r = SupabaseHttp.refreshSession(session.refreshToken)) {
            is SupabaseHttp.RefreshResult.Ok -> {
                if (!AuthStore.save(ctx, r.refreshToken, r.accessToken)) {
                    // Keystore 저장 실패 — 서버는 회전됐지만 로컬이 낡음. 다음 시도에서
                    // Invalid로 수렴할 수 있으나 크래시보다 낫다(§6.1 재인증 폴백).
                    Access.Transient
                } else {
                    Access.Ok(r.accessToken)
                }
            }
            SupabaseHttp.RefreshResult.Invalid -> {
                AuthStore.clearIfTokenMatches(ctx, session.refreshToken)
                AquariumWidgetProvider.updateAll(ctx)
                Access.Invalid
            }
            SupabaseHttp.RefreshResult.Transient -> Access.Transient
        }
    }
}
