package com.aquadesk.app.store

import android.content.Context
import com.aquadesk.app.model.AquariumSnapshot
import java.io.File

/**
 * LocalCacheStore — snapshot.json 읽기 캐시 (설계서/03 §1).
 * ★권위 없음(GUARDRAILS §1): 서버 스냅샷의 로컬 사본일 뿐이며, 상태 변경은 항상
 * 서버 RPC가 권위다. 여기 쓰는 건 브리지 applySnapshot / (추후) SyncWorker 뿐.
 */
object LocalCacheStore {

    private const val FILE_NAME = "snapshot.json"
    private val lock = Any()

    private fun file(ctx: Context): File = File(ctx.filesDir, FILE_NAME)

    /** 캐시 로드 — 없거나 파손이면 기본 스냅샷(환영 물고기 1마리). */
    fun load(ctx: Context): AquariumSnapshot = synchronized(lock) {
        val f = file(ctx)
        if (!f.exists()) return AquariumSnapshot.default()
        return try {
            AquariumSnapshot.fromJson(f.readText())
        } catch (_: Exception) {
            AquariumSnapshot.default()
        }
    }

    /** 검증된 스냅샷 저장(원자적 tmp→rename). */
    fun save(ctx: Context, snapshot: AquariumSnapshot): Unit = synchronized(lock) {
        val tmp = File(ctx.filesDir, "$FILE_NAME.tmp")
        tmp.writeText(snapshot.toJson())
        if (!tmp.renameTo(file(ctx))) {
            // rename 실패(파일시스템 특성) 폴백 — 직접 쓰기.
            file(ctx).writeText(snapshot.toJson())
            tmp.delete()
        }
    }

    /** 원문 JSON 저장 — 파싱 검증을 통과한 경우에만 저장한다(파손 캐시 방지). */
    fun saveRaw(ctx: Context, rawJson: String): AquariumSnapshot {
        val parsed = AquariumSnapshot.fromJson(rawJson) // throws on invalid
        save(ctx, parsed)
        return parsed
    }
}
