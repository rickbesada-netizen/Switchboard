package com.switchboard.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import okhttp3.Request
import org.json.JSONObject
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {
    companion object {
        @Volatile var visible = false
        const val EXTRA_ROOM = "room"
        const val REPO = "rickbesada-netizen/Switchboard"
        const val UI = "https://appassets.androidplatform.net/assets/ui/index.html"
    }

    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pageReady = false
    private var pendingRoom: String? = null

    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data))
        fileCallback = null
    }
    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /** Called from the Switchboard page (remote-shim.js) */
    inner class Bridge {
        @JavascriptInterface fun saveSession(json: String) {
            Prefs.saveSession(this@MainActivity, json)
            runOnUiThread { SyncService.start(this@MainActivity); askBatteryExemption() }
        }
        @JavascriptInterface fun getSession(): String = Prefs.session(this@MainActivity)?.toString() ?: ""
        @JavascriptInterface fun clearSession() {
            Prefs.clear(this@MainActivity)
            runOnUiThread { stopService(Intent(this@MainActivity, SyncService::class.java)) }
        }
        @JavascriptInterface fun deviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingRoom = intent.getStringExtra(EXTRA_ROOM)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)

        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#0d0f14"))
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            // the page talks to your PC over your home network (http) as well as the internet
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        web.addJavascriptInterface(Bridge(), "SBAndroid")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(req.url)
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                if (req.url.host == "appassets.androidplatform.net") return false
                startActivity(Intent(Intent.ACTION_VIEW, req.url))
                return true
            }
            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                pendingRoom?.let { openRoom(it) }
                pendingRoom = null
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                return try {
                    val i = params.createIntent()
                    if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    filePicker.launch(i); true
                } catch (e: Exception) { fileCallback = null; false }
            }
        }
        web.setDownloadListener { dl, _, _, _, _ -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(dl))) }
        setContentView(web)
        web.loadUrl(UI)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript(
                    "(function(){try{var b=document.body.classList;var m=document.getElementById('modal');if(m&&!m.classList.contains('hidden')){closeModal();return true;}if(b.contains('menu-open')){b.remove('menu-open');return true;}if(b.contains('chat-open')){closeChatMobile();return true;}if(typeof S!=='undefined'&&S.view!=='inbox'){showView('inbox');return true;}}catch(e){}return false;})()"
                ) { handled -> if (handled != "true") moveTaskToBack(true) }
            }
        })
        if (Prefs.signedIn(this)) SyncService.start(this)
        checkForUpdate()
    }

    private fun openRoom(room: String) {
        web.evaluateJavascript("(function(){try{openRoom(${JSONObject.quote(room)})}catch(e){location.hash='room='+encodeURIComponent(${JSONObject.quote(room)})}})()", null)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val room = intent.getStringExtra(EXTRA_ROOM) ?: return
        if (pageReady) openRoom(room) else pendingRoom = room
    }

    override fun onResume() { super.onResume(); visible = true }
    override fun onPause() { super.onPause(); visible = false }

    private fun askBatteryExemption() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        val prefs = getSharedPreferences("switchboard-ui", 0)
        if (pm.isIgnoringBatteryOptimizations(packageName) || prefs.getBoolean("askedBattery", false)) return
        prefs.edit().putBoolean("askedBattery", true).apply()
        AlertDialog.Builder(this)
            .setTitle("Keep notifications coming")
            .setMessage("To get message notifications while Switchboard is closed, allow it to run in the background.")
            .setPositiveButton("Allow") { _, _ ->
                try { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) } catch (_: Exception) {}
            }
            .setNegativeButton("Not now", null).show()
    }

    private fun checkForUpdate() {
        thread {
            try {
                val req = Request.Builder().url("https://api.github.com/repos/$REPO/releases/latest").header("Accept", "application/vnd.github+json").build()
                Prefs.http.newCall(req).execute().use { res ->
                    if (!res.isSuccessful) return@thread
                    val tag = JSONObject(res.body?.string() ?: "{}").optString("tag_name").removePrefix("v")
                    if (tag.isNotEmpty() && newer(tag, BuildConfig.VERSION_NAME)) runOnUiThread {
                        AlertDialog.Builder(this)
                            .setTitle("Update available")
                            .setMessage("Switchboard $tag is available (you have ${BuildConfig.VERSION_NAME}).")
                            .setPositiveButton("Download") { _, _ ->
                                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/$REPO/releases/latest/download/Switchboard.apk")))
                            }
                            .setNegativeButton("Later", null).show()
                    }
                }
            } catch (_: Exception) {}
        }
    }
    private fun newer(a: String, b: String): Boolean {
        val x = a.split(".").map { it.toIntOrNull() ?: 0 }
        val y = b.split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val p = x.getOrElse(i) { 0 }; val q = y.getOrElse(i) { 0 }
            if (p != q) return p > q
        }
        return false
    }
}
