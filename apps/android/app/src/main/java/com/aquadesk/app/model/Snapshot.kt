package com.aquadesk.app.model

import org.json.JSONArray
import org.json.JSONObject

/**
 * AquariumSnapshot — 웹/네이티브 공유 JSON 계약의 Kotlin 미러.
 * SoT = packages/game-spec/src/types.ts (GUARDRAILS §5). 필드 드리프트 금지 —
 * 파싱은 관용적으로(누락 필드는 기본값), 직렬화는 계약 필드만 쓴다.
 * 스냅샷의 x/y는 초기 배치 힌트(서버 시드)일 뿐, 런타임 위치 권위는 FishFsm(설계서/03 §3).
 */
data class SlotPlacement(
    val slotId: String,
    val itemId: String,
    val x: Float,
    val y: Float,
    val layer: Int,
)

data class FishSnapshot(
    val id: String,
    val speciesId: String,
    val bodyType: String,      // fusiform | disc | eel
    val nickname: String?,
    val nature: String,        // timid | gluttonous | curious | lone
    val growthStage: Int,      // 1..4
    val sizePct: Float,        // 0..1
    val satisfied: Boolean,
    val x: Float,
    val y: Float,
)

data class PendingAnim(
    val kind: String,          // feed-drop | clean | heart
    val at: Long,
)

data class AquariumSnapshot(
    val version: Int,
    val themeId: String,
    val dayNight: String,      // auto | day | night
    val waterQuality: Float,   // 0..1
    val slots: List<SlotPlacement>,
    val fish: List<FishSnapshot>,
    val pendingAnims: List<PendingAnim>,
) {
    fun toJson(): String {
        val o = JSONObject()
        o.put("version", version)
        o.put("themeId", themeId)
        o.put("dayNight", dayNight)
        o.put("waterQuality", waterQuality.toDouble())
        o.put("slots", JSONArray().apply {
            slots.forEach { s ->
                put(JSONObject().apply {
                    put("slotId", s.slotId); put("itemId", s.itemId)
                    put("x", s.x.toDouble()); put("y", s.y.toDouble()); put("layer", s.layer)
                })
            }
        })
        o.put("fish", JSONArray().apply {
            fish.forEach { f ->
                put(JSONObject().apply {
                    put("id", f.id); put("speciesId", f.speciesId); put("bodyType", f.bodyType)
                    if (f.nickname != null) put("nickname", f.nickname)
                    put("nature", f.nature); put("growthStage", f.growthStage)
                    put("sizePct", f.sizePct.toDouble()); put("satisfied", f.satisfied)
                    put("x", f.x.toDouble()); put("y", f.y.toDouble())
                })
            }
        })
        o.put("pendingAnims", JSONArray().apply {
            pendingAnims.forEach { p ->
                put(JSONObject().apply { put("kind", p.kind); put("at", p.at) })
            }
        })
        return o.toString()
    }

    companion object {
        /** 관용 파싱 — 누락/이형 필드는 기본값. 실패 시 IllegalArgumentException. */
        fun fromJson(raw: String): AquariumSnapshot {
            val o = try { JSONObject(raw) } catch (e: Exception) {
                throw IllegalArgumentException("invalid snapshot json", e)
            }
            val slots = mutableListOf<SlotPlacement>()
            o.optJSONArray("slots")?.let { arr ->
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
            val fish = mutableListOf<FishSnapshot>()
            o.optJSONArray("fish")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val f = arr.optJSONObject(i) ?: continue
                    fish.add(
                        FishSnapshot(
                            id = f.optString("id", "fish-$i"),
                            speciesId = f.optString("speciesId", ""),
                            bodyType = f.optString("bodyType", "fusiform"),
                            nickname = if (f.has("nickname")) f.optString("nickname") else null,
                            nature = f.optString("nature", "curious"),
                            growthStage = f.optInt("growthStage", 1),
                            sizePct = f.optDouble("sizePct", 0.5).toFloat(),
                            satisfied = f.optBoolean("satisfied", true),
                            x = f.optDouble("x", 0.2 + (i % 5) * 0.17).toFloat(),
                            y = f.optDouble("y", 0.3 + (i * 0.137) % 0.5).toFloat(),
                        )
                    )
                }
            }
            val anims = mutableListOf<PendingAnim>()
            o.optJSONArray("pendingAnims")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val p = arr.optJSONObject(i) ?: continue
                    val kind = p.optString("kind", "")
                    if (kind == "feed-drop" || kind == "clean" || kind == "heart") {
                        anims.add(PendingAnim(kind, p.optLong("at", 0L)))
                    }
                }
            }
            return AquariumSnapshot(
                version = o.optInt("version", 1),
                themeId = o.optString("themeId", "deepsea"),
                dayNight = o.optString("dayNight", "auto"),
                waterQuality = o.optDouble("waterQuality", 1.0).toFloat(),
                slots = slots,
                fish = fish,
                pendingAnims = anims,
            )
        }

        /** 캐시 없음/파손 시 기본 스냅샷 — 환영 물고기 1마리(온보딩 전 정적 표시용). */
        fun default(): AquariumSnapshot = AquariumSnapshot(
            version = 0,
            themeId = "deepsea",
            dayNight = "auto",
            waterQuality = 1f,
            slots = emptyList(),
            fish = listOf(
                FishSnapshot(
                    id = "welcome", speciesId = "clownfish", bodyType = "disc",
                    nickname = null, nature = "curious", growthStage = 1,
                    sizePct = 0.5f, satisfied = true, x = 0.5f, y = 0.5f,
                )
            ),
            pendingAnims = emptyList(),
        )
    }
}
