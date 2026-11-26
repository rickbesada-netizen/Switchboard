package com.switchboard.app

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** The Switchboard account session, shared between the app screen and the notification service. */
object Prefs {
    private const val FILE = "switchboard"
    const val SB_URL = "https://jeovbbtpjpgdaruzauee.supabase.co"
    const val SB_KEY = "sb_publishable_nxOCxuA75XAi4x2IdQkRUg_xu0Njzml"

    fun session(ctx: Context): JSONObject? {
        val raw = ctx.getSharedPreferences(FILE, 0).getString("session", null) ?: return null
        return try { JSONObject(raw) } catch (_: Exception) { null }
    }
    fun saveSession(ctx: Context, json: String) {
        val incoming = try { JSONObject(json) } catch (_: Exception) { return }
        val cur = session(ctx)
        // keep whichever session expires later (the app screen and the service both refresh)
        if (cur != null && cur.optLong("expires_at") > incoming.optLong("expires_at") && cur.optString("user_id") == incoming.optString("user_id")) return
        ctx.getSharedPreferences(FILE, 0).edit().putString("session", incoming.toString()).apply()
    }
    fun clear(ctx: Context) = ctx.getSharedPreferences(FILE, 0).edit().remove("session").apply()
    fun signedIn(ctx: Context) = session(ctx) != null

    val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .build()
    }

    /** Returns a valid access token, refreshing it if it's about to expire. Call off the main thread. */
    fun accessToken(ctx: Context): String? {
        val s = session(ctx) ?: return null
        val now = System.currentTimeMillis() / 1000
        if (s.optLong("expires_at") - now > 120) return s.optString("access_token")
        return try {
            val body = JSONObject().put("refresh_token", s.optString("refresh_token")).toString()
                .toRequestBody("application/json".toMediaType())
            val req = Request.Builder().url("$SB_URL/auth/v1/token?grant_type=refresh_token")
                .header("apikey", SB_KEY).post(body).build()
            http.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return null
                val j = JSONObject(res.body?.string() ?: "{}")
                val n = JSONObject()
                    .put("access_token", j.getString("access_token"))
                    .put("refresh_token", j.getString("refresh_token"))
                    .put("expires_at", j.optLong("expires_at", now + j.optLong("expires_in", 3600)))
                    .put("user_id", s.optString("user_id"))
                ctx.getSharedPreferences(FILE, 0).edit().putString("session", n.toString()).apply()
                n.getString("access_token")
            }
        } catch (_: Exception) { null }
    }

    class Host(val name: String, val addresses: List<String>)

    /** Which PC runs the accounts right now (null if none is on). */
    fun currentHost(ctx: Context, token: String): Host? {
        fun get(path: String): String? = try {
            val req = Request.Builder().url("$SB_URL/rest/v1/$path").header("apikey", SB_KEY).header("Authorization", "Bearer $token").build()
            http.newCall(req).execute().use { if (it.isSuccessful) it.body?.string() else null }
        } catch (_: Exception) { null }
        val hs = JSONArray(get("host_state?select=host_device,lease_until") ?: return null)
        if (hs.length() == 0) return null
        val h = hs.getJSONObject(0)
        val dev = h.optString("host_device", "")
        if (dev.isEmpty() || h.isNull("host_device")) return null
        val devs = JSONArray(get("devices?select=id,name,addresses&id=eq.$dev") ?: return null)
        if (devs.length() == 0) return null
        val d = devs.getJSONObject(0)
        val arr = d.optJSONArray("addresses") ?: JSONArray()
        return Host(d.optString("name", "your PC"), (0 until arr.length()).map { arr.getString(it) })
    }

    /** First address of the host PC that answers on this network (home Wi-Fi / Tailscale). */
    fun reachable(host: Host, token: String): String? {
        for (u in host.addresses) {
            try {
                val req = Request.Builder().url("$u/ping?t=$token").build()
                http.newCall(req).execute().use { res ->
                    if (res.isSuccessful && JSONObject(res.body?.string() ?: "{}").optBoolean("paired")) return u
                }
            } catch (_: Exception) {}
        }
        return null
    }
}
