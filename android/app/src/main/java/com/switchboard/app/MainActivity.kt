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
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import okhttp3.Request
import org.json.JSONObject
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {
    companion object {
        @Volatile var visible = false
        const val EXTRA_ROOM = "room"
        const val REPO = "rickbesada-netizen/Switchboard"
    }

    private var web: WebView? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingRoom: String? = null
    private var updateChecked = false

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        val err = Prefs.savePairing(this, text)
        if (err != null) {
            Toast.makeText(this, err, Toast.LENGTH_LONG).show()
        } else {
            Toast.makeText(this, "Paired with ${Prefs.pcName(this)}", Toast.LENGTH_SHORT).show()
            connect()
        }
    }
    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data))
        fileCallback = null
    }
    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingRoom = intent.getStringExtra(EXTRA_ROOM)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val w = web
                if (w == null) { moveTaskToBack(true); return }
                w.evaluateJavascript(
                    "(function(){var b=document.body.classList;if(document.getElementById('modal')&&!document.getElementById('modal').classList.contains('hidden')){closeModal();return true;}if(b.contains('menu-open')){b.remove('menu-open');return true;}if(b.contains('chat-open')){closeChatMobile();return true;}if(typeof S!=='undefined'&&S.view!=='inbox'){showView('inbox');return true;}return false;})()"
                ) { handled -> if (handled != "true") moveTaskToBack(true) }
            }
        })

        if (Prefs.paired(this)) connect() else showPairScreen(null)
        checkForUpdate()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val room = intent.getStringExtra(EXTRA_ROOM) ?: return
        val w = web
        if (w != null) w.evaluateJavascript("openRoom(${JSONObject.quote(room)})", null) else pendingRoom = room
    }

    override fun onResume() { super.onResume(); visible = true }
    override fun onPause() { super.onPause(); visible = false }

    // ------------------------------------------------------------ screens
    private fun page(): LinearLayout {
        web = null
        val l = LinearLayout(this)
        l.orientation = LinearLayout.VERTICAL
        l.gravity = Gravity.CENTER_HORIZONTAL
        l.setPadding(64, 160, 64, 64)
        l.setBackgroundColor(Color.parseColor("#0d0f14"))
        setContentView(l)
        return l
    }
    private fun text(l: LinearLayout, s: String, size: Float, color: String = "#e8eaf0", bold: Boolean = false): TextView {
        val t = TextView(this)
        t.text = s
        t.textSize = size
        t.setTextColor(Color.parseColor(color))
        t.gravity = Gravity.CENTER
        if (bold) t.setTypeface(t.typeface, android.graphics.Typeface.BOLD)
        t.setPadding(0, 16, 0, 16)
        l.addView(t, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return t
    }
    private fun button(l: LinearLayout, s: String, primary: Boolean, onClick: () -> Unit): Button {
        val b = Button(this)
        b.text = s
        b.isAllCaps = false
        b.setTextColor(Color.WHITE)
        b.setBackgroundColor(Color.parseColor(if (primary) "#7c5cff" else "#212634"))
        b.setOnClickListener { onClick() }
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.topMargin = 24
        l.addView(b, lp)
        return b
    }

    private fun showPairScreen(message: String?) {
        val l = page()
        val icon = android.widget.ImageView(this)
        icon.setImageResource(R.mipmap.ic_launcher)
        l.addView(icon, LinearLayout.LayoutParams(220, 220))
        text(l, "Switchboard", 26f, bold = true)
        text(l, message ?: "Open Switchboard on your PC, go to Settings → Phone → Pair a phone, then scan the QR code.", 15f, "#8a91a3")
        button(l, "Scan QR code", true) {
            scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the code shown in Switchboard on your PC").setBeepEnabled(false).setOrientationLocked(false))
        }
        button(l, "Paste pairing code instead", false) {
            val input = EditText(this)
            input.hint = "Pairing code"
            AlertDialog.Builder(this).setTitle("Paste pairing code").setView(input)
                .setPositiveButton("Pair") { _, _ ->
                    val err = Prefs.savePairing(this, input.text.toString())
                    if (err != null) Toast.makeText(this, err, Toast.LENGTH_LONG).show() else connect()
                }.setNegativeButton("Cancel", null).show()
        }
    }

    private fun showUnreachable() {
        val l = page()
        text(l, "Can't reach ${Prefs.pcName(this)}", 22f, bold = true)
        text(l, "Make sure your PC is on, Switchboard is running with phone access turned on, and this phone is on the same Wi-Fi. Away from home, use Tailscale on both (see Settings → Phone on your PC).", 15f, "#8a91a3")
        button(l, "Try again", true) { connect() }
        button(l, "Pair again", false) { Prefs.forget(this); showPairScreen(null) }
    }

    private fun showLoading() {
        val l = page()
        text(l, "Connecting to ${Prefs.pcName(this)}...", 18f)
        l.addView(ProgressBar(this))
    }

    // ------------------------------------------------------------ connect
    private fun connect() {
        showLoading()
        SyncService.start(this)
        askBatteryExemption()
        thread {
            val (reach, url) = Prefs.findPc(this)
            runOnUiThread {
                when (reach) {
                    Prefs.Reach.OK -> openWeb(url!!)
                    Prefs.Reach.NOT_PAIRED -> { Prefs.forget(this); showPairScreen("This phone was removed from Switchboard on your PC. Pair it again.") }
                    Prefs.Reach.UNREACHABLE -> showUnreachable()
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun openWeb(url: String) {
        val w = WebView(this)
        w.setBackgroundColor(Color.parseColor("#0d0f14"))
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        w.settings.mediaPlaybackRequiresUserGesture = false
        w.settings.allowFileAccess = false
        val host = Uri.parse(url).host
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                if (req.url.host == host && req.url.path?.startsWith("/media/") != true) return false
                startActivity(Intent(Intent.ACTION_VIEW, req.url))
                return true
            }
            override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                if (req.isForMainFrame) showUnreachable()
            }
        }
        w.webChromeClient = object : WebChromeClient() {
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
        w.setDownloadListener { dl, _, _, _, _ -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(dl))) }
        val device = Uri.encode("${Build.MANUFACTURER} ${Build.MODEL}")
        val room = pendingRoom?.let { "#room=" + Uri.encode(it) } ?: ""
        pendingRoom = null
        w.loadUrl("$url/?t=${Prefs.token(this)}&device=$device$room")
        setContentView(w)
        web = w
    }

    private fun askBatteryExemption() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        val prefs = getSharedPreferences("switchboard", 0)
        if (pm.isIgnoringBatteryOptimizations(packageName) || prefs.getBoolean("askedBattery", false)) return
        prefs.edit().putBoolean("askedBattery", true).apply()
        AlertDialog.Builder(this)
            .setTitle("Keep notifications coming")
            .setMessage("To get message notifications while Switchboard is closed, allow it to run in the background.")
            .setPositiveButton("Allow") { _, _ ->
                try {
                    startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
                } catch (_: Exception) {}
            }
            .setNegativeButton("Not now", null).show()
    }

    // ------------------------------------------------------------ updates
    private fun checkForUpdate() {
        if (updateChecked) return
        updateChecked = true
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
