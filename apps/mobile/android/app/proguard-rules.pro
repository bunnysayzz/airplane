# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# Add any project specific keep options here:

# T14 in-app updater: the installer module is reached by reflection from JS,
# so a future minify-enabled build must not strip or rename it.
-keep class com.bunnysayzz.airplane.AirplaneInstallerModule { *; }
-keep class com.bunnysayzz.airplane.AirplaneInstallerPackage { *; }
