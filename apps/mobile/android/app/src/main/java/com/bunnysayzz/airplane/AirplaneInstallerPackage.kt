// SPDX-License-Identifier: Apache-2.0
// Manual ReactPackage for the app-owned AirplaneInstaller module.
// App-owned code is not autolinked, so MainApplication adds this package
// explicitly in getPackages().

package com.bunnysayzz.airplane

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class AirplaneInstallerPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(AirplaneInstallerModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
