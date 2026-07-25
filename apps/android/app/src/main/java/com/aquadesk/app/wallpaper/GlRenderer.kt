package com.aquadesk.app.wallpaper

import android.opengl.GLES20
import com.aquadesk.app.model.AquariumSnapshot
import com.aquadesk.app.model.PendingAnim
import com.aquadesk.app.model.SlotPlacement
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.Calendar
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

/**
 * GlRenderer — OpenGL ES 2.0 렌더 (설계서/03 §2).
 * 레이어 합성(back→front): 배경 그라디언트 → 장식 슬롯 → 물고기 → 기포 → 연출/파문 →
 * 수질 틴트 → Day/Night 인디고 오버레이(dusk/dawn 45분 lerp — 하드컷 금지 §2.1).
 * N1 스코프: 텍스처 아틀라스 대신 색 사각형 조립(도트 스냅) — 에셋 파이프라인은 다음 라운드.
 * GL 리소스는 onSurfaceCreated에서 (재)생성, releaseGl에서 해제(§4.1 컨텍스트 손실 대비).
 */
class GlRenderer {

    // ── 셰이더 (단일 프로그램: 위치+정점색) ─────────────────────────────────
    private val vertexSrc = """
        attribute vec2 aPos;
        attribute vec4 aColor;
        varying vec4 vColor;
        void main() {
          vColor = aColor;
          gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0);
        }
    """.trimIndent()

    private val fragmentSrc = """
        precision mediump float;
        varying vec4 vColor;
        void main() { gl_FragColor = vColor; }
    """.trimIndent()

    private var program = 0
    private var aPos = -1
    private var aColor = -1
    private var aspect = 1f // width / height

    // 정점 배치 버퍼(인터리브: x,y,r,g,b,a).
    private val maxVerts = 8192
    private val floatsPerVert = 6
    private val cpu = FloatArray(maxVerts * floatsPerVert)
    private var vertCount = 0
    private val gpu: FloatBuffer = ByteBuffer
        .allocateDirect(maxVerts * floatsPerVert * 4)
        .order(ByteOrder.nativeOrder())
        .asFloatBuffer()

    /** 도트 룩: 이 가상 해상도에 좌표를 스냅. */
    private val grid = 160f

    // ── 씬 상태 ────────────────────────────────────────────────────────────
    private val actors = LinkedHashMap<String, FishActor>()
    private var slots: List<SlotPlacement> = emptyList()
    private var themeId = "deepsea"
    private var dayNight = "auto"
    private var waterQuality = 1f

    private data class Bubble(var x: Float, var y: Float, val speed: Float, val size: Float)
    private val bubbles = MutableList(14) {
        Bubble(Random.nextFloat(), Random.nextFloat(), 0.03f + Random.nextFloat() * 0.05f, 0.004f + Random.nextFloat() * 0.006f)
    }

    private data class Ripple(val x: Float, val y: Float, val born: Double)
    private val ripples = mutableListOf<Ripple>()

    private data class Effect(val kind: String, val born: Double, val seed: Int)
    private val effects = mutableListOf<Effect>()

    // ── 씬 갱신 API (렌더 스레드 밖에서 호출될 수 있어 동기화) ────────────────
    @Synchronized
    fun applySnapshot(s: AquariumSnapshot, now: Double) {
        themeId = s.themeId
        dayNight = s.dayNight
        waterQuality = s.waterQuality
        slots = s.slots.sortedBy { it.layer }
        // 위치 권위는 FSM — 기존 개체 위치 유지, 신규만 스폰, 사라진 개체 제거(§3).
        val nextIds = s.fish.map { it.id }.toSet()
        actors.keys.retainAll(nextIds)
        s.fish.forEach { f ->
            val existing = actors[f.id]
            if (existing == null) actors[f.id] = FishActor(f) else existing.applySnapshot(f, now)
        }
    }

    @Synchronized
    fun playAnims(anims: List<PendingAnim>, now: Double) {
        anims.forEach { effects.add(Effect(it.kind, now, Random.nextInt())) }
    }

    @Synchronized
    fun tapAt(x: Float, y: Float, now: Double) {
        ripples.add(Ripple(x, y, now))
        actors.values.forEach { it.maybeScatter(x, y, now) }
    }

    // ── GL 생명주기 ─────────────────────────────────────────────────────────
    fun onSurfaceCreated() {
        program = linkProgram(compile(GLES20.GL_VERTEX_SHADER, vertexSrc), compile(GLES20.GL_FRAGMENT_SHADER, fragmentSrc))
        aPos = GLES20.glGetAttribLocation(program, "aPos")
        aColor = GLES20.glGetAttribLocation(program, "aColor")
        GLES20.glEnable(GLES20.GL_BLEND)
        GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA)
    }

    fun onSurfaceChanged(width: Int, height: Int) {
        GLES20.glViewport(0, 0, width, height)
        aspect = if (height > 0) width.toFloat() / height else 1f
    }

    fun releaseGl() {
        if (program != 0) {
            GLES20.glDeleteProgram(program)
            program = 0
        }
    }

    // ── 프레임 ──────────────────────────────────────────────────────────────
    @Synchronized
    fun drawFrame(dt: Float, now: Double, postFx: Boolean) {
        val theme = themePalette(themeId)

        actors.values.forEach { it.step(dt, now) }
        bubbles.forEach { b ->
            b.y -= b.speed * dt
            if (b.y < 0.1f) { b.y = 0.98f; b.x = Random.nextFloat() }
        }
        ripples.removeAll { now - it.born > 0.7 }
        effects.removeAll { now - it.born > 2.5 }

        vertCount = 0
        // 1) 배경 수직 그라디언트(도트 밴딩: 8단계 스텝).
        val bands = 8
        for (i in 0 until bands) {
            val t0 = i / bands.toFloat()
            val c = lerp3(theme.top, theme.bottom, t0)
            rect(0f, t0, 1f, 1f / bands + 0.002f, c[0], c[1], c[2], 1f, snap = false)
        }

        // 2) 장식 슬롯.
        slots.forEach { drawDeco(it, now) }

        // 3) 물고기.
        actors.values.forEach { drawFish(it) }

        // 4) 기포.
        bubbles.forEach { b ->
            rect(b.x, b.y, b.size / aspect, b.size, 0.75f, 0.9f, 1f, 0.35f)
        }

        // 5) 연출(pendingAnims 재생: feed-drop / clean / heart) + 터치 파문.
        effects.forEach { drawEffect(it, now) }
        ripples.forEach { drawRipple(it, now) }

        // 6) 수질 틴트(낮을수록 녹조).
        val murk = (1f - waterQuality).coerceIn(0f, 1f)
        if (murk > 0.02f) rect(0f, 0f, 1f, 1f, 0.18f, 0.35f, 0.12f, murk * 0.28f, snap = false)

        // 7) Day/Night 인디고 오버레이 — dusk/dawn 45분 lerp(§2.1, 하드컷 금지).
        val night = nightFactor(now)
        if (night > 0.01f) rect(0f, 0f, 1f, 1f, 0.05f, 0.04f, 0.22f, night * 0.45f, snap = false)

        // 8) 절전 아님 + 야간 → 글로우 힌트(히어로/야광: 간단 additive 근사).
        if (postFx && night > 0.3f) {
            actors.values.filter { it.data.speciesId == "leviathan_koi" }.forEach { f ->
                val s = f.displaySize
                rect(f.x - s, f.y - s, s * 2f / aspect, s * 2f, theme.glow[0], theme.glow[1], theme.glow[2], 0.18f * night)
            }
        }

        flushDraw()
    }

    // ── 그리기 헬퍼 ─────────────────────────────────────────────────────────
    private fun snapCoord(v: Float): Float = floor(v * grid) / grid

    private fun rect(x: Float, y: Float, w: Float, h: Float, r: Float, g: Float, b: Float, a: Float, snap: Boolean = true) {
        if (vertCount + 6 > maxVerts) return
        val x0 = if (snap) snapCoord(x) else x
        val y0 = if (snap) snapCoord(y) else y
        val x1 = x0 + w
        val y1 = y0 + h
        val v = floatArrayOf(x0, y0, x1, y0, x0, y1, x1, y0, x1, y1, x0, y1)
        for (i in 0 until 6) {
            val base = (vertCount + i) * floatsPerVert
            cpu[base] = v[i * 2]
            cpu[base + 1] = v[i * 2 + 1]
            cpu[base + 2] = r; cpu[base + 3] = g; cpu[base + 4] = b; cpu[base + 5] = a
        }
        vertCount += 6
    }

    private fun drawFish(f: FishActor) {
        val p = speciesPalette(f.data.speciesId)
        val s = f.displaySize
        val a = f.alpha
        val d = f.dirX // 1 = 오른쪽 향함
        val w = { u: Float -> u * s / aspect } // 가로는 종횡비 보정

        when (f.data.bodyType) {
            "eel" -> {
                // 장어형: 길쭉한 몸 3분절 + 꼬리.
                rect(f.x - w(1.4f), f.y - s * 0.25f, w(2.4f), s * 0.5f, p[0], p[1], p[2], a)
                rect(f.x - w(1.8f) * d - w(0.2f), f.y - s * 0.15f, w(0.5f), s * 0.3f, p[0] * 0.8f, p[1] * 0.8f, p[2] * 0.8f, a)
                rect(f.x + w(0.7f) * d, f.y - s * 0.12f, w(0.16f), s * 0.16f, 0.05f, 0.08f, 0.1f, a) // 눈
            }
            "disc" -> {
                // 원반형: 정사각 몸 + 배 줄무늬 + 꼬리 + 눈.
                rect(f.x - w(0.55f), f.y - s * 0.55f, w(1.1f), s * 1.1f, p[0], p[1], p[2], a)
                rect(f.x - w(0.55f), f.y - s * 0.1f, w(1.1f), s * 0.28f, p[3], p[4], p[5], a)
                rect(f.x - w(0.95f) * d - w(0.2f), f.y - s * 0.3f, w(0.42f), s * 0.6f, p[0] * 0.85f, p[1] * 0.85f, p[2] * 0.85f, a)
                rect(f.x + w(0.28f) * d, f.y - s * 0.28f, w(0.16f), s * 0.16f, 0.05f, 0.08f, 0.1f, a)
            }
            else -> {
                // 방추형(기본): 몸 + 배 + 꼬리 + 등지느러미 + 눈.
                rect(f.x - w(0.8f), f.y - s * 0.4f, w(1.6f), s * 0.8f, p[0], p[1], p[2], a)
                rect(f.x - w(0.8f), f.y + s * 0.05f, w(1.6f), s * 0.25f, p[3], p[4], p[5], a)
                rect(f.x - w(1.15f) * d - w(0.18f), f.y - s * 0.28f, w(0.4f), s * 0.56f, p[0] * 0.85f, p[1] * 0.85f, p[2] * 0.85f, a)
                rect(f.x - w(0.15f), f.y - s * 0.62f, w(0.5f), s * 0.24f, p[0] * 0.9f, p[1] * 0.9f, p[2] * 0.9f, a)
                rect(f.x + w(0.42f) * d, f.y - s * 0.2f, w(0.16f), s * 0.16f, 0.05f, 0.08f, 0.1f, a)
            }
        }
    }

    private fun drawDeco(slot: SlotPlacement, now: Double) {
        val x = slot.x
        val y = slot.y
        val id = slot.itemId
        val w = { u: Float -> u / aspect }
        when {
            id.contains("rock") -> {
                val big = id.contains("large")
                val s = if (big) 0.07f else 0.045f
                rect(x - w(s), y - s * 0.6f, w(s * 2f), s, 0.42f, 0.44f, 0.5f, 1f)
                rect(x - w(s * 0.6f), y - s, w(s * 1.2f), s * 0.5f, 0.5f, 0.52f, 0.58f, 1f)
            }
            id.contains("seaweed") -> {
                val sway = sin(now * 1.4).toFloat() * 0.008f
                rect(x - w(0.008f), y - 0.1f, w(0.016f), 0.1f, 0.15f, 0.55f, 0.3f, 1f)
                rect(x - w(0.008f) + sway / aspect, y - 0.17f, w(0.016f), 0.08f, 0.18f, 0.62f, 0.34f, 1f)
            }
            id.contains("coral") -> {
                val pink = id.contains("pink")
                val r = if (pink) 0.95f else 0.35f
                val g = if (pink) 0.45f else 0.55f
                val b = if (pink) 0.6f else 0.95f
                rect(x - w(0.035f), y - 0.045f, w(0.07f), 0.045f, r, g, b, 1f)
                rect(x - w(0.018f), y - 0.075f, w(0.016f), 0.035f, r, g, b, 1f)
                rect(x + w(0.006f), y - 0.065f, w(0.014f), 0.025f, r * 0.9f, g * 0.9f, b * 0.9f, 1f)
            }
            id.contains("treasure") -> {
                rect(x - w(0.035f), y - 0.04f, w(0.07f), 0.04f, 0.55f, 0.4f, 0.15f, 1f)
                rect(x - w(0.035f), y - 0.055f, w(0.07f), 0.018f, 0.85f, 0.7f, 0.25f, 1f)
            }
            id.contains("shipwreck") -> {
                rect(x - w(0.09f), y - 0.05f, w(0.18f), 0.05f, 0.35f, 0.25f, 0.16f, 1f)
                rect(x - w(0.02f), y - 0.11f, w(0.02f), 0.07f, 0.3f, 0.22f, 0.14f, 1f)
            }
            id.contains("castle") -> {
                rect(x - w(0.05f), y - 0.09f, w(0.1f), 0.09f, 0.62f, 0.65f, 0.72f, 1f)
                rect(x - w(0.065f), y - 0.12f, w(0.025f), 0.12f, 0.55f, 0.58f, 0.66f, 1f)
                rect(x + w(0.04f), y - 0.12f, w(0.025f), 0.12f, 0.55f, 0.58f, 0.66f, 1f)
            }
            id.contains("lantern") -> {
                rect(x - w(0.015f), y - 0.05f, w(0.03f), 0.05f, 0.95f, 0.8f, 0.4f, 0.9f)
                rect(x - w(0.03f), y - 0.065f, w(0.06f), 0.075f, 1f, 0.85f, 0.45f, 0.16f) // 은은한 광
            }
            id.contains("bubbler") -> {
                rect(x - w(0.015f), y - 0.03f, w(0.03f), 0.03f, 0.6f, 0.7f, 0.8f, 1f)
                val t = ((now * 0.6) % 1.0).toFloat()
                rect(x - w(0.004f), y - 0.05f - t * 0.25f, w(0.008f), 0.012f, 0.8f, 0.92f, 1f, 0.5f * (1f - t))
            }
            else -> rect(x - w(0.02f), y - 0.03f, w(0.04f), 0.03f, 0.5f, 0.6f, 0.7f, 1f)
        }
    }

    private fun drawEffect(e: Effect, now: Double) {
        val t = ((now - e.born) / 2.5).toFloat().coerceIn(0f, 1f)
        val rnd = Random(e.seed)
        when (e.kind) {
            "feed-drop" -> {
                for (i in 0 until 6) {
                    val fx = 0.25f + rnd.nextFloat() * 0.5f
                    val fy = t * (0.55f + rnd.nextFloat() * 0.25f)
                    rect(fx, fy, 0.008f / aspect, 0.008f, 0.85f, 0.6f, 0.3f, 1f - t * 0.6f)
                }
            }
            "clean" -> {
                for (i in 0 until 10) {
                    val fx = rnd.nextFloat()
                    val fy = rnd.nextFloat() * 0.8f + 0.1f
                    val tw = (sin((now * 6 + i).toDouble()) * 0.5 + 0.5).toFloat()
                    rect(fx, fy, 0.01f / aspect, 0.01f, 0.85f, 0.95f, 1f, tw * (1f - t))
                }
            }
            "heart" -> {
                val fy = 0.75f - t * 0.45f
                val fx = 0.5f + sin((now * 3).toDouble()).toFloat() * 0.03f
                val a = 1f - t
                rect(fx - 0.012f / aspect, fy, 0.012f / aspect, 0.012f, 1f, 0.45f, 0.6f, a)
                rect(fx + 0.001f / aspect, fy, 0.012f / aspect, 0.012f, 1f, 0.45f, 0.6f, a)
                rect(fx - 0.008f / aspect, fy + 0.01f, 0.018f / aspect, 0.012f, 1f, 0.45f, 0.6f, a)
            }
        }
    }

    private fun drawRipple(r: Ripple, now: Double) {
        // 3프레임 스프라이트 파티클 근사(설계서/03 §5 — RenderEffect/AGSL 회피).
        val t = ((now - r.born) / 0.7).toFloat().coerceIn(0f, 1f)
        val stage = min(2, (t * 3).toInt())
        val radius = 0.02f + stage * 0.02f
        val a = (1f - t) * 0.6f
        val th = 0.006f
        rect(r.x - radius / aspect, r.y - radius, radius * 2f / aspect, th, 0.8f, 0.92f, 1f, a)
        rect(r.x - radius / aspect, r.y + radius, radius * 2f / aspect, th, 0.8f, 0.92f, 1f, a)
        rect(r.x - radius / aspect, r.y - radius, th / aspect, radius * 2f, 0.8f, 0.92f, 1f, a)
        rect(r.x + radius / aspect, r.y - radius, th / aspect, radius * 2f + th, 0.8f, 0.92f, 1f, a)
    }

    private fun flushDraw() {
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
        GLES20.glUseProgram(program)
        gpu.clear()
        gpu.put(cpu, 0, vertCount * floatsPerVert)
        gpu.position(0)
        GLES20.glEnableVertexAttribArray(aPos)
        GLES20.glEnableVertexAttribArray(aColor)
        val stride = floatsPerVert * 4
        gpu.position(0)
        GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, stride, gpu)
        gpu.position(2)
        GLES20.glVertexAttribPointer(aColor, 4, GLES20.GL_FLOAT, false, stride, gpu)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, vertCount)
        GLES20.glDisableVertexAttribArray(aPos)
        GLES20.glDisableVertexAttribArray(aColor)
    }

    // ── 팔레트/시간 ─────────────────────────────────────────────────────────
    private class Theme(val top: FloatArray, val bottom: FloatArray, val glow: FloatArray)

    private fun themePalette(id: String): Theme = when (id) {
        "cyberpunk" -> Theme(
            floatArrayOf(0.09f, 0.03f, 0.16f), floatArrayOf(0.02f, 0.01f, 0.07f),
            floatArrayOf(0.95f, 0.3f, 0.85f),
        )
        "emerald" -> Theme(
            floatArrayOf(0.02f, 0.22f, 0.18f), floatArrayOf(0.01f, 0.08f, 0.07f),
            floatArrayOf(0.4f, 1f, 0.7f),
        )
        else -> Theme( // deepsea
            floatArrayOf(0.04f, 0.13f, 0.25f), floatArrayOf(0.01f, 0.04f, 0.1f),
            floatArrayOf(0.5f, 0.85f, 1f),
        )
    }

    /** body r,g,b + belly r,g,b. */
    private fun speciesPalette(id: String): FloatArray = when (id) {
        "clownfish" -> floatArrayOf(1f, 0.55f, 0.2f, 0.98f, 0.92f, 0.85f)
        "tang" -> floatArrayOf(0.25f, 0.45f, 0.95f, 0.95f, 0.85f, 0.3f)
        "guppy" -> floatArrayOf(0.35f, 0.8f, 0.75f, 0.9f, 0.65f, 0.75f)
        "neon_tetra" -> floatArrayOf(0.3f, 0.85f, 0.95f, 0.9f, 0.25f, 0.3f)
        "moray_eel" -> floatArrayOf(0.35f, 0.5f, 0.3f, 0.6f, 0.65f, 0.4f)
        "leviathan_koi" -> floatArrayOf(0.95f, 0.95f, 0.98f, 0.9f, 0.3f, 0.25f)
        else -> {
            val h = id.hashCode()
            floatArrayOf(
                0.4f + (h and 0xFF) / 512f, 0.4f + ((h shr 8) and 0xFF) / 512f, 0.5f + ((h shr 16) and 0xFF) / 512f,
                0.8f, 0.8f, 0.85f,
            )
        }
    }

    private fun lerp3(a: FloatArray, b: FloatArray, t: Float): FloatArray =
        floatArrayOf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)

    /**
     * Day/Night 가중치 0(주간)..1(야간) — §2.1.
     * auto: 06:00/18:00 경계 전후 45분 lerp(device local time). day/night: 고정.
     */
    private fun nightFactor(@Suppress("UNUSED_PARAMETER") now: Double): Float {
        when (dayNight) {
            "day" -> return 0f
            "night" -> return 1f
        }
        val cal = Calendar.getInstance()
        val minutes = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE)
        val dawn = 6 * 60    // 야간→주간
        val dusk = 18 * 60   // 주간→야간
        val band = 45f
        return when {
            minutes < dawn - band || minutes >= dusk + band -> 1f
            minutes in (dawn + band.toInt()) until (dusk - band.toInt()) -> 0f
            // dawn 경계 보간(야간 1 → 주간 0)
            minutes < dawn + band -> ((dawn + band - minutes) / (band * 2f)).coerceIn(0f, 1f)
            // dusk 경계 보간(주간 0 → 야간 1)
            else -> ((minutes - (dusk - band)) / (band * 2f)).coerceIn(0f, 1f)
        }
    }

    // ── 셰이더 유틸 ─────────────────────────────────────────────────────────
    private fun compile(type: Int, src: String): Int {
        val id = GLES20.glCreateShader(type)
        GLES20.glShaderSource(id, src)
        GLES20.glCompileShader(id)
        val ok = IntArray(1)
        GLES20.glGetShaderiv(id, GLES20.GL_COMPILE_STATUS, ok, 0)
        if (ok[0] == 0) {
            val log = GLES20.glGetShaderInfoLog(id)
            GLES20.glDeleteShader(id)
            throw RuntimeException("shader compile failed: $log")
        }
        return id
    }

    private fun linkProgram(vs: Int, fs: Int): Int {
        val id = GLES20.glCreateProgram()
        GLES20.glAttachShader(id, vs)
        GLES20.glAttachShader(id, fs)
        GLES20.glLinkProgram(id)
        val ok = IntArray(1)
        GLES20.glGetProgramiv(id, GLES20.GL_LINK_STATUS, ok, 0)
        GLES20.glDeleteShader(vs)
        GLES20.glDeleteShader(fs)
        if (ok[0] == 0) {
            val log = GLES20.glGetProgramInfoLog(id)
            GLES20.glDeleteProgram(id)
            throw RuntimeException("program link failed: $log")
        }
        return id
    }
}
