package com.aquadesk.app.wallpaper

import com.aquadesk.app.model.PendingAnim
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * AnimQueue — ★비가시 큐잉 (설계서/03 §4.1·§4.2, R1).
 * 배경이 가려진 동안 도착한 연출(feed-drop/clean/heart)을 적재해 두었다가
 * onVisibilityChanged(true)에 flush해 재생한다. 이 큐가 없으면
 * "알림/위젯에서 먹였는데 홈 복귀 시 아무 일도 없던" 버그가 난다.
 */
class AnimQueue {
    private val queue = ConcurrentLinkedQueue<PendingAnim>()

    fun enqueue(anims: List<PendingAnim>) {
        anims.forEach { queue.add(it) }
    }

    /** 적재분 전부 꺼내 반환(재생은 렌더러 책임). */
    fun flush(): List<PendingAnim> {
        val out = mutableListOf<PendingAnim>()
        while (true) {
            val a = queue.poll() ?: break
            out.add(a)
        }
        return out
    }

    fun isEmpty(): Boolean = queue.isEmpty()
}
