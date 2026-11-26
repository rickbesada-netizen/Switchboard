package com.switchboard.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * Keeps a small connection open so message notifications arrive while the app is closed:
 * straight to your PC on the home network, or through the Switchboard relay from anywhere.
 */
class SyncService : Service() {
    companion object {
        const val CH_STATUS = "status"
        const val CH_MESSAGES = "messages"
        fun start(ctx: Context) {
            if (!Prefs.signedIn(ctx)) return
            try { ContextCompat.startForegroundService(ctx, Intent(ctx, SyncService::class.java)) } catch (_: Exception) {}
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var stopped = false
    private var backoff = 4000L
    private var heartbeat: Runnable? = null
    private var ref = 1

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_STATUS, "Connection", NotificationManager.IMPORTANCE_MIN))
        nm.createNotificationChannel(NotificationChannel(CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH))
        status("Connecting...")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!Prefs.signedIn(this)) { stopSelf(); return START_NOT_STICKY }
        if (socket == null) connect()
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        heartbeat?.let { main.removeCallbacks(it) }
        socket?.close(1000, null)
        super.onDestroy()
    }

    private fun status(text: String) {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, CH_STATUS)
            .setSmallIcon(R.drawable.ic_stat_sb)
            .setContentTitle("Switchboard")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
        ServiceCompat.startForeground(this, 1, n, type)
    }

    private fun retry() {
        if (stopped) return
        heartbeat?.let { main.removeCallbacks(it) }
        main.postDelayed({ connect() }, backoff)
        backoff = minOf(backoff * 2, 60000L)
    }

    private fun connect() {
        if (stopped) return
        thread {
            val token = Prefs.accessToken(this)
            if (token == null) { main.post { status("Open Switchboard to sign in again."); retry() }; return@thread }
            val host = Prefs.currentHost(this, token)
            if (host == null) { main.post { status("Waiting for your PC to come online..."); retry() }; return@thread }
            val direct = Prefs.reachable(host, token)
            if (direct != null) connectDirect(direct, token, host.name) else connectRelay(token, host.name)
        }
    }

    // On the same network (or Tailscale): straight to the PC
    private fun connectDirect(base: String, token: String, name: String) {
        val url = base.replaceFirst("http", "ws") + "/ws?notify=1&t=" + token + "&device=" + Uri.encode(Build.MANUFACTURER + " " + Build.MODEL)
        socket = Prefs.http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { backoff = 4000L; main.post { status("Connected to $name") } }
            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val o = JSONObject(text)
                    if (o.optString("ev") == "notify") notifyFrom(o.getJSONArray("args").getJSONObject(0))
                } catch (_: Exception) {}
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { socket = null; main.post { status("Reconnecting..."); retry() } }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { socket = null; main.post { status("Reconnecting..."); retry() } }
        })
    }

    // Away from home: the private Switchboard relay (Supabase Realtime, Phoenix protocol)
    private fun connectRelay(token: String, name: String) {
        val uid = Prefs.session(this)?.optString("user_id") ?: return
        val topic = "realtime:sb:$uid"
        val ws = Prefs.SB_URL.replaceFirst("https", "wss") + "/realtime/v1/websocket?apikey=" + Prefs.SB_KEY + "&vsn=1.0.0"
        socket = Prefs.http.newWebSocket(Request.Builder().url(ws).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val join = JSONObject()
                    .put("topic", topic).put("event", "phx_join").put("ref", (ref++).toString()).put("join_ref", "1")
                    .put("payload", JSONObject()
                        .put("config", JSONObject()
                            .put("broadcast", JSONObject().put("self", false).put("ack", false))
                            .put("presence", JSONObject().put("key", ""))
                            .put("private", true))
                        .put("access_token", token))
                webSocket.send(join.toString())
                val hb = object : Runnable {
                    override fun run() {
                        val t = Prefs.session(this@SyncService)?.optString("access_token")
                        webSocket.send(JSONObject().put("topic", "phoenix").put("event", "heartbeat").put("payload", JSONObject()).put("ref", (ref++).toString()).toString())
                        if (t != null) webSocket.send(JSONObject().put("topic", topic).put("event", "access_token").put("payload", JSONObject().put("access_token", t)).put("ref", (ref++).toString()).toString())
                        main.postDelayed(this, 25000)
                    }
                }
                heartbeat = hb
                main.postDelayed(hb, 25000)
                // refresh the token in the background so the relay stays signed in
                main.postDelayed({ thread { Prefs.accessToken(this@SyncService) } }, 20 * 60000L)
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val o = JSONObject(text)
                    when (o.optString("event")) {
                        "phx_reply" -> {
                            val p = o.optJSONObject("payload")
                            if (p?.optString("status") == "ok" && o.optString("topic") == topic) { backoff = 4000L; main.post { status("Connected to $name (away from home)") } }
                            if (p?.optString("status") == "error") webSocket.close(1000, null)
                        }
                        "broadcast" -> {
                            val p = o.getJSONObject("payload")
                            if (p.optString("event") == "notify") notifyFrom(p.getJSONObject("payload"))
                        }
                        "phx_error", "phx_close", "system" -> if (o.optString("event") != "system" || o.optJSONObject("payload")?.optString("status") == "error") webSocket.close(1000, null)
                    }
                } catch (_: Exception) {}
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { socket = null; main.post { status("Reconnecting..."); retry() } }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { socket = null; main.post { status("Reconnecting..."); retry() } }
        })
    }

    private fun notifyFrom(a: JSONObject) {
        if (MainActivity.visible) return
        val title = a.optString("title")
        val body = a.optString("body")
        val roomId = a.optString("roomId")
        val i = Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_ROOM, roomId).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pi = PendingIntent.getActivity(this, roomId.hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(this, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_sb)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        try { getSystemService(NotificationManager::class.java).notify(roomId.hashCode(), n) } catch (_: SecurityException) {}
    }
}
