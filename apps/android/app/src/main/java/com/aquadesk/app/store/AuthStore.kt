package com.aquadesk.app.store

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AuthStore — refresh token 암호화 저장 (설계서/03 §6, GUARDRAILS §7).
 * Android Keystore(AES/GCM) 키로 암호화해 SharedPreferences에 보관.
 * ★R8: refresh의 단일 주체는 네이티브(SyncWorker — 다음 라운드). 웹은 getAuthSession으로
 * 읽어 재사용만 하고 독립 refresh 하지 않는다.
 */
object AuthStore {

    private const val KEY_ALIAS = "aquadesk_auth_key"
    private const val PREFS = "aquadesk_auth"
    private const val PREF_CIPHER = "session_cipher"
    private const val PREF_IV = "session_iv"
    private const val GCM_TAG_BITS = 128

    data class AuthSession(
        val refreshToken: String,
        val accessToken: String?,
    ) {
        fun toJson(): String = JSONObject().apply {
            put("refreshToken", refreshToken)
            if (accessToken != null) put("accessToken", accessToken)
        }.toString()
    }

    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    /**
     * 저장 성공 여부 반환 — Keystore는 기기별로 실제 예외(KeyStoreException/ProviderException)를
     * 던진다. 위젯 raw thread에서 uncaught면 프로세스(=라이브 배경 포함) 전체가 죽으므로
     * 절대 throw하지 않는다(리뷰 확정 결함 픽스).
     */
    fun save(ctx: Context, refreshToken: String, accessToken: String?): Boolean = try {
        val plain = AuthSession(refreshToken, accessToken).toJson().toByteArray(Charsets.UTF_8)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val encrypted = cipher.doFinal(plain)
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(PREF_CIPHER, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString(PREF_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
        true
    } catch (_: Exception) {
        false
    }

    /**
     * compare-and-clear: 저장된 refresh token이 `expectedRefreshToken`일 때만 파기.
     * refresh Invalid 판정 시 무조건 clear하면, 판정 사이에 다른 경로가 회전·저장한
     * '유효한 새 토큰'까지 지워버린다(리뷰 확정 결함 픽스 — 회전 임계구역 정합).
     */
    fun clearIfTokenMatches(ctx: Context, expectedRefreshToken: String) {
        val current = load(ctx)
        if (current?.refreshToken == expectedRefreshToken) clear(ctx)
    }

    fun load(ctx: Context): AuthSession? {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val enc = prefs.getString(PREF_CIPHER, null) ?: return null
        val iv = prefs.getString(PREF_IV, null) ?: return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                secretKey(),
                GCMParameterSpec(GCM_TAG_BITS, Base64.decode(iv, Base64.NO_WRAP)),
            )
            val plain = cipher.doFinal(Base64.decode(enc, Base64.NO_WRAP))
            val o = JSONObject(String(plain, Charsets.UTF_8))
            AuthSession(
                refreshToken = o.getString("refreshToken"),
                accessToken = if (o.has("accessToken")) o.getString("accessToken") else null,
            )
        } catch (_: Exception) {
            null // 키 회전/파손 → 세션 없음으로 취급(재인증 유도 폴백 — 설계서/03 §6.1)
        }
    }

    fun clear(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }
}
