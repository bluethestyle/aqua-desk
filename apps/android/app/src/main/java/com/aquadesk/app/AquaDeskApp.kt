package com.aquadesk.app

import android.app.Application
import com.aquadesk.app.sync.SyncWorker

/**
 * 앱 프로세스 초기화 — 주기 동기화 등록(설계서/03 §6).
 * WorkManager 제약(제조사 절전) 대비 배터리 예외 안내는 P1.
 */
class AquaDeskApp : Application() {
    override fun onCreate() {
        super.onCreate()
        SyncWorker.schedulePeriodic(this)
    }
}
