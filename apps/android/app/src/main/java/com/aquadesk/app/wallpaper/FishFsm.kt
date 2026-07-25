package com.aquadesk.app.wallpaper

import com.aquadesk.app.model.FishSnapshot
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlin.random.Random

/**
 * FishFsm — 물고기 행동 FSM + 성격 가중치 (설계서/03 §3).
 * Idle/Swim ─(탭)→ Scatter ─(2s)→ Idle · ─(랜덤)→ Peek/Yawn · satisfied=false → Sulk.
 * ★런타임 위치 권위는 여기(스냅샷 x/y는 초기 배치 힌트) — 동기화 시 위치 강제 리셋 금지.
 */
enum class FishState { IDLE, SWIM, SCATTER, PEEK, YAWN, SULK }

class FishActor(snapshot: FishSnapshot) {
    var data: FishSnapshot = snapshot
        private set

    var x: Float = snapshot.x.coerceIn(0.05f, 0.95f)
    var y: Float = snapshot.y.coerceIn(0.15f, 0.9f)
    var dirX: Float = if (Random.nextBoolean()) 1f else -1f
    var state: FishState = if (snapshot.satisfied) FishState.SWIM else FishState.SULK
        private set

    private var stateUntil: Double = 0.0
    private var heading: Float = Random.nextFloat() * 6.2832f
    private var wobble: Float = Random.nextFloat() * 6.2832f
    /** 기본 유영 속도(정규화 단위/s) — 개체별 편차. */
    private val baseSpeed: Float = 0.028f * (0.8f + Random.nextFloat() * 0.4f)

    /** 시각 크기(정규화 높이 비율): 성장 단계 + size_pct. */
    val displaySize: Float
        get() = 0.028f + data.growthStage * 0.008f + data.sizePct * 0.018f

    /** Sulk = 반투명·은신(설계서/03 §3). */
    val alpha: Float
        get() = if (state == FishState.SULK) 0.45f else 1f

    /** 서버 스냅샷 갱신 반영 — 위치는 유지, 상태 파생만 갱신. */
    fun applySnapshot(next: FishSnapshot, now: Double) {
        data = next
        if (!next.satisfied) {
            state = FishState.SULK
        } else if (state == FishState.SULK) {
            state = FishState.IDLE
            stateUntil = now + 1.0
        }
    }

    /** 탭 산란 트리거 — timid는 반경 ×2 (설계서/03 §3 가중치). */
    fun maybeScatter(cx: Float, cy: Float, now: Double) {
        if (state == FishState.SULK) return
        val radius = if (data.nature == "timid") 0.36f else 0.18f
        if (hypot((x - cx).toDouble(), (y - cy).toDouble()) <= radius) {
            state = FishState.SCATTER
            stateUntil = now + 2.0
            // 탭 반대 방향으로 도주.
            dirX = if (cx > x) -1f else 1f
            heading = if (dirX > 0) 0f else 3.1416f
        }
    }

    fun step(dt: Float, now: Double) {
        // 상태 만료 → 복귀.
        if (state != FishState.SULK && state != FishState.SWIM && now >= stateUntil) {
            state = FishState.SWIM
        }
        // 랜덤 Peek/Yawn (curious는 Peek 확률 +30%).
        if (state == FishState.SWIM && Random.nextFloat() < dt * 0.02f) {
            val peekChance = if (data.nature == "curious") 0.65f else 0.5f
            state = if (Random.nextFloat() < peekChance) FishState.PEEK else FishState.YAWN
            stateUntil = now + 1.5
        }

        val speed = when (state) {
            FishState.SCATTER -> baseSpeed * 4f
            FishState.SULK -> baseSpeed * 0.25f
            FishState.PEEK, FishState.YAWN -> baseSpeed * 0.15f
            else -> baseSpeed
        }

        // 유영: 완만한 heading 드리프트 + 상하 wobble. lone은 외곽 패트롤 바이어스.
        wobble += dt * 2.2f
        heading += (Random.nextFloat() - 0.5f) * dt * 1.2f
        if (data.nature == "lone") {
            val targetX = if (x < 0.5f) 0.12f else 0.88f
            heading += (if (targetX > x) -abs(sin(heading)) else abs(sin(heading))) * dt * 0.2f
        }

        // heading이 진행 방향의 유일한 권위 — dirX는 스프라이트 좌우 플립용 파생값.
        x += cos(heading) * speed * dt
        y += (sin(heading) * 0.3f + sin(wobble) * 0.15f) * speed * dt
        dirX = if (cos(heading) >= 0f) 1f else -1f

        // 경계 반사.
        if (x < 0.05f) { x = 0.05f; heading = 0f; dirX = 1f }
        if (x > 0.95f) { x = 0.95f; heading = 3.1416f; dirX = -1f }
        if (y < 0.15f) y = 0.15f
        if (y > 0.9f) y = 0.9f
    }
}
