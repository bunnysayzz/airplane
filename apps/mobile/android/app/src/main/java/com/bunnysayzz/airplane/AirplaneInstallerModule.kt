// SPDX-License-Identifier: Apache-2.0
// T14 in-app updater: download, hash, install. App-owned native module,
// registered manually in MainApplication (autolinking does not cover
// app-owned code). Legacy @ReactMethod module: it runs under the
// bridgeless interop layer, and the CI Gradle build is the gate that it
// compiles. No new dependency: HttpURLConnection plus FileProvider only.
//
// Safety rules, enforced here and in JS: only https download URLs, the
// APK is written only inside the updates cache dir, install only ever
// fires from a file inside that dir, and nothing here installs silently:
// installApk opens the system install sheet and the user taps Install.

package com.bunnysayzz.airplane

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class AirplaneInstallerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "AirplaneInstaller"

  private fun updatesDir(): File {
    val dir = File(reactApplicationContext.cacheDir, "updates")
    if (!dir.exists()) dir.mkdirs()
    return dir
  }

  private fun isInUpdatesDir(file: File): Boolean {
    val dir = updatesDir().canonicalFile
    val target = file.canonicalFile
    return target.path.startsWith(dir.path + File.separator)
  }

  private fun emitProgress(received: Long, total: Long) {
    val params: WritableMap = Arguments.createMap()
    params.putDouble("received", received.toDouble())
    params.putDouble("total", total.toDouble())
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("AirplaneInstallerDownloadProgress", params)
  }

  @ReactMethod
  fun canInstallPackages(promise: Promise) {
    try {
      val allowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactApplicationContext.packageManager.canRequestPackageInstalls()
      } else {
        // Before Android 8 the unknown-sources switch is global, not
        // per app, so there is no per-app grant to check.
        true
      }
      promise.resolve(allowed)
    } catch (e: Exception) {
      promise.reject("CAN_INSTALL_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun openUnknownSourcesSettings(promise: Promise) {
    try {
      val intent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:" + reactApplicationContext.packageName)
      )
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactApplicationContext.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("SETTINGS_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun downloadApk(url: String, fileName: String, promise: Promise) {
    Thread {
      try {
        val parsed = URL(url)
        if (parsed.protocol != "https") {
          promise.reject("INVALID_URL", "only https download URLs are allowed")
          return@Thread
        }
        val dir = updatesDir()
        // Stale cleanup: the cache dir holds at most one APK.
        dir.listFiles()?.forEach { file ->
          if (file.isFile && file.name.endsWith(".apk") && file.name != fileName) {
            file.delete()
          }
        }
        val target = File(dir, fileName)
        val connection = parsed.openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = true
        connection.connectTimeout = 30_000
        connection.readTimeout = 120_000
        connection.setRequestProperty("User-Agent", "Airplane-updater")
        connection.connect()
        val status = connection.responseCode
        if (status !in 200..299) {
          connection.disconnect()
          promise.reject("DOWNLOAD_FAILED", "HTTP $status")
          return@Thread
        }
        val total = connection.contentLengthLong
        val digest = MessageDigest.getInstance("SHA-256")
        var received = 0L
        var lastEmitted = 0L
        connection.inputStream.use { input ->
          FileOutputStream(target).use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              output.write(buffer, 0, read)
              digest.update(buffer, 0, read)
              received += read
              if (received - lastEmitted >= 256 * 1024 || received == total) {
                lastEmitted = received
                emitProgress(received, total)
              }
            }
          }
        }
        connection.disconnect()
        val hex = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
        val result: WritableMap = Arguments.createMap()
        result.putString("path", target.absolutePath)
        result.putString("sha256", hex)
        result.putDouble("bytes", received.toDouble())
        promise.resolve(result)
      } catch (e: Exception) {
        promise.reject("DOWNLOAD_FAILED", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun installApk(path: String, promise: Promise) {
    try {
      val file = File(path)
      if (!isInUpdatesDir(file) || !file.isFile) {
        promise.reject("INVALID_PATH", "APK path is outside the updates cache dir")
        return
      }
      val uri = FileProvider.getUriForFile(
        reactApplicationContext,
        reactApplicationContext.packageName + ".fileprovider",
        file
      )
      val intent = Intent(Intent.ACTION_INSTALL_PACKAGE)
      intent.setDataAndType(uri, "application/vnd.android.package-archive")
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactApplicationContext.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("INSTALL_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun deleteFile(path: String, promise: Promise) {
    try {
      val file = File(path)
      if (!isInUpdatesDir(file)) {
        promise.resolve(false)
        return
      }
      promise.resolve(file.delete() || !file.exists())
    } catch (e: Exception) {
      promise.reject("DELETE_FAILED", e.message, e)
    }
  }
}
