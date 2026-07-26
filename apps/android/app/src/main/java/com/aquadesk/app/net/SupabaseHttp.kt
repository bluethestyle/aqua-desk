package com.aquadesk.app.net

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * SupabaseHttp — 네이티브 최소 REST 클라이언트 (설계서/03 §6).
 * anon(publishable) 키 + 사용자 JWT만 사용(GUARDRAILS §7 — service 키 절대 금지).
 * 쓰기는 전부 RPC 경유(서버 권위 §1) — 여기서 테이블 직접 write API를 제공하지 않는다.
 */
object SupabaseHttp {

    /** 클라 노출 허용 공개 값(웹 번들과 동일 — 시크릿 아님). */
    const val SUPABASE_URL = "https://cflqnkuhfyxhwwoksxzc.supabase.co"
    const val ANON_KEY = "sb_publishable_gZKxZqCX8ZrKC4Bces8fGw_cJT0PfAz"

    // 위젯 경로 최악 체인(rpc→refresh→rpc, 각 connect+read)이 백그라운드 브로드캐스트
    // 데드라인(~60s) 아래에 들어오도록 6s로 캡: 6s×2×3 = 36s (리뷰 픽스).
    private const val TIMEOUT_MS = 6_000

    data class HttpResult(val status: Int, val body: String) {
        val ok: Boolean get() = status in 200..299
    }

    sealed class RefreshResult {
        data class Ok(val accessToken: String, val refreshToken: String) : RefreshResult()
        /** 400/401/403 = refresh 무효(만료·회전 실패·로그아웃) → 토큰 파기 + 재인증 유도(§6.1). */
        object Invalid : RefreshResult()
        /** 네트워크/서버 일시 오류 → 재시도 대상. */
        object Transient : RefreshResult()
    }

    /** refresh → access 갱신. ★네이티브가 단일 refresh 주체(R8) — 회전된 refresh 저장 필수. */
    fun refreshSession(refreshToken: String): RefreshResult {
        val res = request(
            method = "POST",
            url = "$SUPABASE_URL/auth/v1/token?grant_type=refresh_token",
            body = JSONObject().put("refresh_token", refreshToken).toString(),
            accessToken = null,
            profileHeader = null,
        ) ?: return RefreshResult.Transient
        return when {
            res.ok -> try {
                val o = JSONObject(res.body)
                RefreshResult.Ok(o.getString("access_token"), o.getString("refresh_token"))
            } catch (_: Exception) {
                RefreshResult.Transient
            }
            res.status in 400..403 -> RefreshResult.Invalid
            else -> RefreshResult.Transient
        }
    }

    /** aquadesk 스키마 RPC 호출(POST /rest/v1/rpc/{fn}). null = 네트워크 오류. */
    fun rpc(fn: String, args: JSONObject, accessToken: String): HttpResult? = request(
        method = "POST",
        url = "$SUPABASE_URL/rest/v1/rpc/$fn",
        body = args.toString(),
        accessToken = accessToken,
        profileHeader = "Content-Profile",
    )

    /** aquadesk 스키마 SELECT(GET /rest/v1/{pathAndQuery}). null = 네트워크 오류. */
    fun select(pathAndQuery: String, accessToken: String): HttpResult? = request(
        method = "GET",
        url = "$SUPABASE_URL/rest/v1/$pathAndQuery",
        body = null,
        accessToken = accessToken,
        profileHeader = "Accept-Profile",
    )

    private fun request(
        method: String,
        url: String,
        body: String?,
        accessToken: String?,
        profileHeader: String?,
    ): HttpResult? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                setRequestProperty("apikey", ANON_KEY)
                setRequestProperty("Authorization", "Bearer ${accessToken ?: ANON_KEY}")
                if (profileHeader != null) setRequestProperty(profileHeader, "aquadesk")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
            }
            if (body != null) conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            HttpResult(status, text)
        } catch (_: IOException) {
            null
        } finally {
            conn?.disconnect()
        }
    }
}
