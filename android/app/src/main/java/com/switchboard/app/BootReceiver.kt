package com.switchboard.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restarts the notification connection after the phone reboots or the app updates. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        SyncService.start(context)
    }
}
