package com.bunnysayzz.airplane

import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.uimanager.ViewManager

/**
 * Legacy (non-Turbo) bridge for the T4 foreground service. The service
 * itself is registered manually in MainApplication (it is app code, not an
 * autolinked library, so PackageList never sees it). Exposes only
 * start/stop/running-state: the JS lifecycle module owns the state
 * machine and the user preference, this module only talks to Android.
 */
@ReactModule(name = AirplaneForegroundServiceModule.NAME)
class AirplaneForegroundServiceModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "AirplaneForegroundService"
  }

  override fun getName(): String = NAME

  @ReactMethod
  fun startService(promise: Promise) {
    try {
      if (AirplaneForegroundService.isRunning) {
        promise.resolve(true)
        return
      }
      val intent = Intent(reactApplicationContext, AirplaneForegroundService::class.java)
      ContextCompat.startForegroundService(reactApplicationContext, intent)
      // startForegroundService is async: the service reports itself via
      // isRunning once onStartCommand lands. A start that throws (missing
      // permission, background-start restriction) resolves false instead.
      promise.resolve(true)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun stopService(promise: Promise) {
    try {
      val intent = Intent(reactApplicationContext, AirplaneForegroundService::class.java)
      reactApplicationContext.stopService(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun isRunning(promise: Promise) {
    promise.resolve(AirplaneForegroundService.isRunning)
  }
}

class AirplaneForegroundServicePackage : ReactPackage {
  override fun createNativeModules(
    reactContext: ReactApplicationContext,
  ): List<NativeModule> = listOf(AirplaneForegroundServiceModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
