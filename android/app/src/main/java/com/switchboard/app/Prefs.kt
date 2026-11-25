package com.switchboard.app

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Saved pairing with the PC: its addresses and this phone's token. */
object Prefs {
    private const val FILE = "switchboard"

    fun token(ctx: Context): String = ctx.getSharedPreferences(FILE, 0).getString("token", "") ?: ""
    fun pcName(ctx: Context): String = ctx.getSharedPreferences(FILE, 0).getString("name", "your PC") ?: "your PC"
    fun urls(ctx: Context): List<String> {
        val raw = ctx.getSharedPreferences(FILE, 0).getString("urls", "[]") ?: "[]"
        val arr = JSONArray(raw)
        val last = ctx.getSharedPreferences(FILE, 0).getString("lastUrl", null)
        val list = (0 until arr.length()).map { arr.getString(it) }.toMutableList()
        if (last != null && list.remove(last)) list.add(0, last)
        return list
    }
    fun paired(ctx: Context) = token(ctx).isNotEmpty() && urls(ctx).isNotEmpty()

    /** Accepts the QR text from Switchboard on the PC. Returns an error message or null. */
    fun savePairing(ctx: Context, text: String): String? {
        return try {
            val o = JSONObject(text.trim())
            if (o.optString("app") != "switchboard") return "That isn't a Switchboard pairing code."
            val urls = o.getJSONArray("urls")
            if (urls.length() == 0) return "Your PC has no network connection."
            ctx.getSharedPreferences(FILE, 0).edit()
                .putString("token", o.getString("token"))
                .putString("urls", urls.toString())
                .putString("name", o.optString("name", "your PC"))
                .remove("lastUrl")
                .apply()
            null
        } catch (e: Exception) {
            "That code couldn't be read. Make a new one on your PC (Settings → Phone → Pair a phone)."
        }
    }
    fun forget(ctx: Context) = ctx.getSharedPreferences(FILE, 0).edit().clear().apply()
    fun rememberUrl(ctx: Context, url: String) = ctx.getSharedPreferences(FILE, 0).edit().putString("lastUrl", url).apply()

    val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(4, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .build()
    }

    enum class Reach { OK, NOT_PAIRED, UNREACHABLE }

    /** Finds the first PC address that answers (home Wi-Fi or Tailscale). Call off the main thread. */
    fun findPc(ctx: Context): Pair<Reach, String?> {
        val token = token(ctx)
        for (u in urls(ctx)) {
            try {
                val req = Request.Builder().url("$u/ping?t=$token").build()
                http.newCall(req).execute().use { res ->
                    if (res.isSuccessful) {
                        val o = JSONObject(res.body?.string() ?: "{}")
                        if (o.optString("app") == "switchboard") {
                            rememberUrl(ctx, u)
                            return if (o.optBoolean("paired")) Reach.OK to u else Reach.NOT_PAIRED to u
                        }
                    }
                }
            } catch (_: Exception) {
            }
        }
        return Reach.UNREACHABLE to null
    }
}
