package com.aquadesk.app.wallpaper

import android.database.ContentObserver
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.service.wallpaper.WallpaperService
import android.view.MotionEvent
import android.view.SurfaceHolder
import com.aquadesk.app.ipc.WallpaperBus
import com.aquadesk.app.store.LocalCacheStore

/**
 * AquariumWallpaperService — Surface 생명주기 + GL 컨텍스트 + FPS/가시성 제어 (설계서/03 §1·§4).
 *  - 가시성 게이팅: 비가시 = 렌더 스레드 정지(0fps), 가시 = resume + AnimQueue.flush (R1).
 *  - IPC: WallpaperBus(ContentObserver) 구독 → 캐시 reload + 연출 재생/큐잉 (§4.2·§4.3).
 *  - Surface 재생성 시 GL 리소스 재생성, 파괴 시 해제 (§4.1 — stale 핸들 방지).
 */
class AquariumWallpaperService : WallpaperService() {

    override fun onCreateEngine(): Engine = AquariumEngine()

    inner class AquariumEngine : Engine() {

        private val renderer = GlRenderer()
        private val animQueue = AnimQueue()
        private var observer: ContentObserver? = null
        private var glThread: GlThread? = null

        @Volatile private var lastTouchAt = 0L

        /**
         * 연출 워터마크(at 최대값) — pendingAnims는 캐시에 잔존하므로, 무관한 notify
         * (설정 토글 등)마다 같은 연출이 유령 재생되는 것을 막는다(리뷰 확정 결함 픽스).
         */
        private var animWatermark = 0L

        private fun nowSec(): Double = System.nanoTime() / 1_000_000_000.0

        /** 워터마크 이후의 새 연출만 골라 워터마크를 전진시킨다. */
        private fun takeFreshAnims(
            anims: List<com.aquadesk.app.model.PendingAnim>,
        ): List<com.aquadesk.app.model.PendingAnim> {
            val fresh = anims.filter { it.at > animWatermark }
            if (fresh.isNotEmpty()) animWatermark = fresh.maxOf { it.at }
            return fresh
        }

        override fun onCreate(surfaceHolder: SurfaceHolder) {
            super.onCreate(surfaceHolder)
            setTouchEventsEnabled(true)
            val initial = LocalCacheStore.load(applicationContext)
            // 서비스 재시작 시 캐시에 남은 과거 연출은 재생하지 않는다.
            animWatermark = initial.pendingAnims.maxOfOrNull { it.at } ?: 0L
            renderer.applySnapshot(initial, nowSec())

            // 캐시 변경 통지(브리지 applySnapshot / QuickAction / SyncWorker) 구독.
            observer = WallpaperBus.observe(applicationContext) {
                val snap = LocalCacheStore.load(applicationContext)
                renderer.applySnapshot(snap, nowSec())
                val fresh = takeFreshAnims(snap.pendingAnims)
                if (fresh.isEmpty()) return@observe
                if (isVisible) {
                    renderer.playAnims(fresh, nowSec())
                } else {
                    // ★R1 비가시 큐잉 — 복귀 시 flush 재생.
                    animQueue.enqueue(fresh)
                }
            }
        }

        override fun onVisibilityChanged(visible: Boolean) {
            glThread?.setVisible(visible)
            if (visible) {
                val queued = animQueue.flush()
                if (queued.isNotEmpty()) renderer.playAnims(queued, nowSec())
            }
        }

        override fun onSurfaceCreated(holder: SurfaceHolder) {
            super.onSurfaceCreated(holder)
            glThread = GlThread(holder).also { it.start() }
            glThread?.setVisible(isVisible)
        }

        override fun onSurfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
            super.onSurfaceChanged(holder, format, width, height)
            glThread?.setSize(width, height)
        }

        override fun onSurfaceDestroyed(holder: SurfaceHolder) {
            super.onSurfaceDestroyed(holder)
            glThread?.finish()
            glThread = null
        }

        override fun onDestroy() {
            super.onDestroy()
            observer?.let { WallpaperBus.unobserve(applicationContext, it) }
            observer = null
            glThread?.finish()
            glThread = null
        }

        override fun onTouchEvent(event: MotionEvent) {
            super.onTouchEvent(event)
            if (event.action == MotionEvent.ACTION_DOWN) {
                lastTouchAt = System.currentTimeMillis()
                val t = glThread ?: return
                if (t.surfaceWidth > 0 && t.surfaceHeight > 0) {
                    renderer.tapAt(
                        event.x / t.surfaceWidth,
                        event.y / t.surfaceHeight,
                        nowSec(),
                    )
                    t.wake() // 파문 즉시 반영(대기 중이면 깨움)
                }
            }
        }

        /**
         * GL 렌더 스레드 — EGL14 수동 관리(WallpaperService에는 GLSurfaceView가 없다).
         * fps = ShaderGate 정책(0/8/15/30). 0이면 wait로 완전 정지(배터리).
         */
        inner class GlThread(private val holder: SurfaceHolder) : Thread("AquaDeskGL") {

            private val lock = Object()
            @Volatile private var quit = false
            @Volatile private var visible = false
            @Volatile var surfaceWidth = 0
                private set
            @Volatile var surfaceHeight = 0
                private set
            @Volatile private var sizeDirty = false

            private var eglDisplay: EGLDisplay = EGL14.EGL_NO_DISPLAY
            private var eglContext: EGLContext = EGL14.EGL_NO_CONTEXT
            private var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE

            fun setVisible(v: Boolean) {
                visible = v
                wake()
            }

            fun setSize(w: Int, h: Int) {
                surfaceWidth = w
                surfaceHeight = h
                sizeDirty = true
                wake()
            }

            fun finish() {
                quit = true
                wake()
                join(1_000)
            }

            fun wake() = synchronized(lock) { lock.notifyAll() }

            override fun run() {
                var lastFrameNs = System.nanoTime()
                while (!quit) {
                    val fps = ShaderGate.targetFps(
                        applicationContext, visible, lastTouchAt, System.currentTimeMillis(),
                    )
                    if (fps == 0) {
                        synchronized(lock) {
                            if (!quit && !visible) lock.wait()
                        }
                        lastFrameNs = System.nanoTime()
                        continue
                    }
                    if (!ensureEgl()) {
                        synchronized(lock) { if (!quit) lock.wait(200) }
                        continue
                    }
                    if (sizeDirty) {
                        renderer.onSurfaceChanged(surfaceWidth, surfaceHeight)
                        sizeDirty = false
                    }

                    val nowNs = System.nanoTime()
                    val dt = ((nowNs - lastFrameNs) / 1_000_000_000.0).toFloat().coerceIn(0f, 0.25f)
                    lastFrameNs = nowNs

                    renderer.drawFrame(
                        dt,
                        nowNs / 1_000_000_000.0,
                        ShaderGate.postFxEnabled(applicationContext),
                    )
                    if (!EGL14.eglSwapBuffers(eglDisplay, eglSurface)) {
                        // 컨텍스트 손실(회전/메모리 회수) → 다음 루프에서 재생성(§4.1).
                        releaseEgl()
                    }

                    val frameMs = 1_000L / fps
                    val elapsedMs = (System.nanoTime() - nowNs) / 1_000_000
                    val sleepMs = frameMs - elapsedMs
                    if (sleepMs > 0) synchronized(lock) { if (!quit) lock.wait(sleepMs) }
                }
                releaseEgl()
            }

            private fun ensureEgl(): Boolean {
                if (eglSurface != EGL14.EGL_NO_SURFACE) return true
                val surface = holder.surface
                if (surface == null || !surface.isValid) return false

                eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
                if (eglDisplay == EGL14.EGL_NO_DISPLAY) return false
                val version = IntArray(2)
                if (!EGL14.eglInitialize(eglDisplay, version, 0, version, 1)) return false

                val attribs = intArrayOf(
                    EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                    EGL14.EGL_RED_SIZE, 8,
                    EGL14.EGL_GREEN_SIZE, 8,
                    EGL14.EGL_BLUE_SIZE, 8,
                    EGL14.EGL_ALPHA_SIZE, 8,
                    EGL14.EGL_NONE,
                )
                val configs = arrayOfNulls<EGLConfig>(1)
                val num = IntArray(1)
                if (!EGL14.eglChooseConfig(eglDisplay, attribs, 0, configs, 0, 1, num, 0) || num[0] == 0) {
                    return false
                }
                val config = configs[0] ?: return false

                eglContext = EGL14.eglCreateContext(
                    eglDisplay, config, EGL14.EGL_NO_CONTEXT,
                    intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0,
                )
                if (eglContext == EGL14.EGL_NO_CONTEXT) return false

                eglSurface = EGL14.eglCreateWindowSurface(
                    eglDisplay, config, surface, intArrayOf(EGL14.EGL_NONE), 0,
                )
                if (eglSurface == EGL14.EGL_NO_SURFACE) return false
                if (!EGL14.eglMakeCurrent(eglDisplay, eglSurface, eglSurface, eglContext)) return false

                // GL 리소스 (재)생성 — 컨텍스트 손실 후에도 여기서 항상 재컴파일(§4.1).
                renderer.onSurfaceCreated()
                if (surfaceWidth > 0) renderer.onSurfaceChanged(surfaceWidth, surfaceHeight)
                return true
            }

            private fun releaseEgl() {
                if (eglDisplay != EGL14.EGL_NO_DISPLAY) {
                    renderer.releaseGl()
                    EGL14.eglMakeCurrent(
                        eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT,
                    )
                    if (eglSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(eglDisplay, eglSurface)
                    if (eglContext != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(eglDisplay, eglContext)
                    EGL14.eglTerminate(eglDisplay)
                }
                eglDisplay = EGL14.EGL_NO_DISPLAY
                eglContext = EGL14.EGL_NO_CONTEXT
                eglSurface = EGL14.EGL_NO_SURFACE
            }
        }
    }
}
