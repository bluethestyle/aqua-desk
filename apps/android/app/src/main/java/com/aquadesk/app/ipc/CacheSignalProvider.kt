package com.aquadesk.app.ipc

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri

/**
 * CacheSignalProvider — 통지 전용 ContentProvider (설계서/03 §4.3).
 * 데이터는 제공하지 않는다. contentResolver.notifyChange(SIGNAL_URI)의 앵커 역할만.
 * LocalBroadcast 금지(GUARDRAILS §10) — 프로세스 분리 기동에도 ContentObserver는 안전.
 */
class CacheSignalProvider : ContentProvider() {
    override fun onCreate(): Boolean = true
    override fun query(
        uri: Uri, projection: Array<out String>?, selection: String?,
        selectionArgs: Array<out String>?, sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(
        uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?,
    ): Int = 0
}
