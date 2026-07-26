package com.aquadesk.app.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.aquadesk.app.ipc.WallpaperBus
import com.aquadesk.app.model.AquariumSnapshot
import com.aquadesk.app.model.FishSnapshot
import com.aquadesk.app.model.SlotPlacement
import com.aquadesk.app.net.SupabaseHttp
import com.aquadesk.app.store.LocalCacheStore
import com.aquadesk.app.widget.AquariumWidgetProvider
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * SyncWorker — 백그라운드 동기화 + ★네이티브 단일 refresh 주체 (설계서/03 §6, R8).
 *  1) AuthStore refresh → access 갱신(회전된 refresh 저장 — 웹은 독립 refresh 금지)
 *  2) 어항 스냅샷 pull(자기 행 SELECT — 서버 권위 읽기 캐시)
 *  3) LocalCacheStore 갱신 + WallpaperBus.notify(ContentObserver)
 *  refresh 무효 → 토큰 파기 + 위젯 비활성(§4.4) + 배경은 마지막 캐시 정적 표시(§6.1).
 */
class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    companion object {
        private const val UNIQUE_PERIODIC = "aqua-sync-periodic"
        private const val UNIQUE_ONCE = "aqua-sync-once"
        private const val PREFS = "aquadesk_sync"
        private const val PREF_AQUARIUM_ID = "aquarium_id"

        /** 주기 동기화(30분, 네트워크 필요). 재등록은 KEEP — 중복 없음. */
        fun schedulePeriodic(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<SyncWorker>(30, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                UNIQUE_PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req,
            )
        }

        /** 즉시 1회(로그인 직후/QuickAction 정합 재동기화). REPLACE — 최신 요청만. */
        fun enqueueOnce(ctx: Context) {
            val req = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                UNIQUE_ONCE, ExistingWorkPolicy.REPLACE, req,
            )
        }

        /** QuickAction이 RPC 대상 어항 id를 재사용할 수 있게 보관(스냅샷 계약에는 id가 없다). */
        fun savedAquariumId(ctx: Context): String? =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(PREF_AQUARIUM_ID, null)

        private fun saveAquariumId(ctx: Context, id: String) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(PREF_AQUARIUM_ID, id).apply()
        }
    }

    private sealed class Pull {
        data class Ok(val snapshot: AquariumSnapshot) : Pull()
        /** 4xx/빈 결과 — 재시도로 해결되지 않음. 다음 주기까지 대기(무한 retry 금지). */
        object Permanent : Pull()
        /** 네트워크/5xx — 일시 오류. */
        object Transient : Pull()
    }

    override fun doWork(): Result {
        val ctx = applicationContext

        // 1) 유효 access 확보 — 회전은 TokenRefresher 전역 임계구역에서만(R8).
        //    access가 아직 유효하면 회전하지 않는다(재시도마다 회전하던 결함 픽스).
        val access = when (val a = TokenRefresher.ensureAccess(ctx)) {
            is TokenRefresher.Access.Ok -> a.token
            TokenRefresher.Access.NoSession -> return Result.success() // 비로그인 — 조용히 스킵
            TokenRefresher.Access.Invalid -> return Result.success()  // 파기·위젯 처리는 Refresher가 수행
            TokenRefresher.Access.Transient ->
                return if (runAttemptCount >= 3) Result.failure() else Result.retry()
        }

        // 2) 스냅샷 pull(자기 행 SELECT — 웹 loadLobby 매핑 미러).
        val snapshot = when (val p = pullSnapshot(ctx, access)) {
            is Pull.Ok -> p.snapshot
            Pull.Permanent -> return Result.success() // 다음 주기에 재시도(서버/데이터 상태 문제)
            Pull.Transient ->
                return if (runAttemptCount >= 3) Result.failure() else Result.retry()
        }

        // 3) 캐시 갱신 + 배경/위젯 통지.
        LocalCacheStore.save(ctx, snapshot)
        WallpaperBus.notify(ctx)
        AquariumWidgetProvider.updateAll(ctx)
        return Result.success()
    }

    private fun pullSnapshot(ctx: Context, access: String): Pull {
        val aqRes = SupabaseHttp.select(
            "aquariums?idx=eq.1&select=id,theme_id,water_quality,version,slots", access,
        ) ?: return Pull.Transient
        if (!aqRes.ok) return if (aqRes.status >= 500) Pull.Transient else Pull.Permanent
        val aq = JSONArray(aqRes.body).optJSONObject(0) ?: return Pull.Permanent
        val aquariumId = aq.optString("id")
        if (aquariumId.isNotBlank()) saveAquariumId(ctx, aquariumId)
        val waterQuality = aq.optDouble("water_quality", 1.0).toFloat()

        val profRes = SupabaseHttp.select("profiles?select=settings", access)
        val dayNight = profRes?.takeIf { it.ok }?.let {
            JSONArray(it.body).optJSONObject(0)?.optJSONObject("settings")
                ?.optString("dayNight", "auto")
        } ?: "auto"

        val fishRes = SupabaseHttp.select(
            "fish_instances?aquarium_id=eq.$aquariumId" +
                "&select=id,species_id,nickname,nature,growth_stage,hunger,size_pct,fish_species(body_type)" +
                "&order=born_at.asc",
            access,
        ) ?: return Pull.Transient
        if (!fishRes.ok) return if (fishRes.status >= 500) Pull.Transient else Pull.Permanent

        val fishArr = JSONArray(fishRes.body)
        val fish = mutableListOf<FishSnapshot>()
        for (i in 0 until fishArr.length()) {
            val f = fishArr.optJSONObject(i) ?: continue
            val speciesRow: JSONObject? = when (val emb = f.opt("fish_species")) {
                is JSONObject -> emb
                is JSONArray -> emb.optJSONObject(0)
                else -> null
            }
            fish.add(
                FishSnapshot(
                    id = f.optString("id", "fish-$i"),
                    speciesId = f.optString("species_id", ""),
                    bodyType = speciesRow?.optString("body_type", "fusiform") ?: "fusiform",
                    nickname = if (f.isNull("nickname")) null else f.optString("nickname"),
                    nature = f.optString("nature", "curious"),
                    growthStage = f.optInt("growth_stage", 1),
                    sizePct = f.optDouble("size_pct", 0.5).toFloat(),
                    // satisfied 파생(hunger>0 && 수질>0.3) — 웹 aquarium.ts와 동일 규칙.
                    satisfied = f.optInt("hunger", 1) > 0 && waterQuality > 0.3f,
                    x = 0.15f + (i % 5) * 0.17f,
                    y = 0.3f + ((i * 0.137f) % 0.5f),
                )
            )
        }

        val slots = mutableListOf<SlotPlacement>()
        aq.optJSONArray("slots")?.let { arr ->
            for (i in 0 until arr.length()) {
                val s = arr.optJSONObject(i) ?: continue
                slots.add(
                    SlotPlacement(
                        slotId = s.optString("slotId", "slot-$i"),
                        itemId = s.optString("itemId", ""),
                        x = s.optDouble("x", 0.5).toFloat(),
                        y = s.optDouble("y", 0.6).toFloat(),
                        layer = s.optInt("layer", i),
                    )
                )
            }
        }

        return Pull.Ok(
            AquariumSnapshot(
                version = aq.optInt("version", 1),
                themeId = aq.optString("theme_id", "deepsea"),
                dayNight = dayNight,
                waterQuality = waterQuality,
                slots = slots,
                fish = fish,
                pendingAnims = emptyList(), // 주기 pull은 연출 없음(연출은 액션 경로가 큐잉)
            )
        )
    }
}
