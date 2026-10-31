package com.bunnysayzz.airplane

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * T4 background relay: a keep-alive foreground service, nothing more.
 *
 * The JS hybrid transport (BLE mesh + Nostr relays, existing flood/dedup
 * logic) owns all relaying; this service only keeps the app process alive
 * while backgrounded so Android does not kill that transport, and it makes
 * the background work visible with a persistent notification the user can
 * stop from. It runs no BLE code, no socket, and no relay protocol of its
 * own. If the OS kills the process anyway, the service does NOT restart
 * itself (START_NOT_STICKY): a resurrected service with no JS transport
 * behind it would report "running" while relaying nothing. The JS side
 * re-asserts the service on next launch and on background transitions
 * while the user preference is on (see services/airplane/foregroundService.ts).
 *
 * Type connectedDevice (plan fix 6): this is a Bluetooth-adjacent
 * background task, so it declares FOREGROUND_SERVICE_CONNECTED_DEVICE and
 * the connectedDevice foreground-service type, not a generic data-sync
 * service. Android 14+ requires that permission for this type.
 */
class AirplaneForegroundService : Service() {

  companion object {
    const val ACTION_STOP = "com.bunnysayzz.airplane.STOP_FOREGROUND_RELAY"
    const val CHANNEL_ID = "airplane-foreground-relay"
    const val NOTIFICATION_ID = 1

    /** True between startForeground and onDestroy. Read by the JS bridge. */
    @Volatile
    var isRunning: Boolean = false
      private set
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      createChannel()
      val notification = buildNotification()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      isRunning = true
    } catch (e: Exception) {
      // A missing foreground-service permission (or any start failure)
      // must not crash the app: the JS side reads isRunning=false and
      // reports the service as unavailable.
      isRunning = false
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    isRunning = false
    super.onDestroy()
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Airplane background relay",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Shows while Airplane keeps relaying posts in the background."
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(): Notification {
    val stopIntent = Intent(this, AirplaneForegroundService::class.java).apply {
      action = ACTION_STOP
    }
    val stopPending = PendingIntent.getService(
      this,
      0,
      stopIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    // Tapping the notification body re-opens the app via the launcher
    // activity; the Stop action ends the service without opening it.
    val openIntent = packageManager.getLaunchIntentForPackage(packageName)
    val openPending = openIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Airplane relay running")
      .setContentText("Relaying posts in the background. Tap Stop to turn it off.")
      .setSmallIcon(R.mipmap.ic_launcher)
      .setOngoing(true)
      .setShowWhen(false)
      .addAction(0, "Stop", stopPending)
    if (openPending != null) builder.setContentIntent(openPending)
    return builder.build()
  }
}
