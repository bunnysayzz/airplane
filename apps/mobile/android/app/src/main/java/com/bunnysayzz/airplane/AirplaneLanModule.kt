package com.bunnysayzz.airplane

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReactPackage
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * T15 Phase 1: Wi-Fi LAN transport (Android only).
 *
 * Legacy (non-Turbo) bridge, same pattern as the T4 foreground-service
 * module: app code, manually registered in MainApplication, so
 * PackageList never sees it. JS owns the transport state machine
 * (LanTransport in packages/transport); this module only talks to
 * Android: NSD service registration/discovery plus a TCP server.
 *
 * Service: type "_airplane._tcp.", name "airplane-<first 8 hex of the
 * device pubkey>", TXT record pk=<full pubkey hex>, v=1. The pubkey is
 * the peer identity: posts already carry it in the clear, so putting
 * it in a TXT record reveals nothing a LAN observer could not already
 * read from a post. A name collision is harmless: NsdManager renames
 * the service, and peers resolve identity from the TXT record, never
 * from the name.
 *
 * Wire format: one TCP frame is a 4-byte big-endian length followed by
 * exactly that many bytes of one protocol fragment (the same
 * fragment format BLE uses). A sender opens one connection per frame
 * and closes it; the server loops reading frames until the connection
 * closes, so a reusing sender also works. Frames larger than 1 MiB
 * are dropped at the door; the JS reassembly layer caps a complete
 * event at 4096 bytes anyway, so a large frame can never become a
 * large in-memory event.
 *
 * Failure posture is fail-soft, matching the app: startLan resolves
 * true when the server and NSD calls did not throw. Registration and
 * discovery report asynchronously; a failure there simply means no
 * peers are discovered (inbound still works if registration
 * succeeded, outbound needs a discovered peer). No promise is ever
 * left unresolved, and no exception escapes into JS.
 */
@ReactModule(name = AirplaneLanModule.NAME)
class AirplaneLanModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "AirplaneLan"
    const val SERVICE_TYPE = "_airplane._tcp."
    const val EVENT_PEER = "AirplaneLanPeer"
    const val EVENT_FRAME = "AirplaneLanFrame"
    const val MAX_FRAME_BYTES = 1024 * 1024
    const val CONNECT_TIMEOUT_MS = 3000
  }

  override fun getName(): String = NAME

  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile
  private var running = false

  /** pubkey hex -> (host, port), from resolved NSD services. */
  private val peers = ConcurrentHashMap<String, Pair<String, Int>>()

  private var nsdManager: NsdManager? = null
  private var registeredService: NsdServiceInfo? = null
  private var serverSocket: ServerSocket? = null

  private val registrationListener = object : NsdManager.RegistrationListener {
    override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
      registeredService = serviceInfo
    }

    override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
      registeredService = null
    }

    override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {
      if (registeredService === serviceInfo) registeredService = null
    }

    override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
      registeredService = null
    }
  }

  // One listener per resolve: NsdManager allows only one outstanding
  // resolve per listener, and several peers can be found in a burst.
  private fun newResolveListener(): NsdManager.ResolveListener {
    return object : NsdManager.ResolveListener {
      override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
        // A peer that cannot resolve is simply not added; the next
        // discovery event retries it. Nothing to surface to JS.
      }

      override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
        val pkBytes = serviceInfo.attributes["pk"] ?: return
        val peerId = String(pkBytes, Charsets.UTF_8)
        if (peerId.isEmpty()) return
        val host = serviceInfo.host?.hostAddress ?: return
        peers[peerId] = Pair(host, serviceInfo.port)
        emitPeer(peerId, host, serviceInfo.port, true)
      }
    }
  }

  private val discoveryListener = object : NsdManager.DiscoveryListener {
    override fun onDiscoveryStarted(serviceType: String) {}
    override fun onDiscoveryStopped(serviceType: String) {}

    override fun onServiceFound(serviceInfo: NsdServiceInfo) {
      val manager = nsdManager ?: return
      try {
        manager.resolveService(serviceInfo, newResolveListener())
      } catch (_: Exception) {
        // Resolve failures are retried on the next discovery event.
      }
    }

    override fun onServiceLost(serviceInfo: NsdServiceInfo) {
      // Lost events carry no TXT record, so the peer is matched by
      // service name only when it is unambiguous: name is
      // "airplane-<first 8 hex>" plus a possible " (n)" rename suffix
      // from a name collision, and the map key is the full pubkey.
      // A tag matching exactly one known peer removes it; an
      // ambiguous tag removes nothing rather than the wrong peer.
      // A stale peer that is never removed is harmless for delivery:
      // its sends fail and the router falls through to mesh.
      val tag = serviceInfo.serviceName.removePrefix("airplane-").take(8)
      val matches = peers.keys.filter { it.startsWith(tag) }
      if (matches.size == 1) {
        val peerId = matches[0]
        peers.remove(peerId)
        emitPeer(peerId, "", 0, false)
      }
    }

    override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
    override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
  }

  private fun emit(event: String, params: WritableMap) {
    mainHandler.post {
      try {
        reactApplicationContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(event, params)
      } catch (_: Exception) {
        // JS gone (app torn down): dropping the event is correct.
      }
    }
  }

  private fun emitPeer(peerId: String, host: String, port: Int, present: Boolean) {
    val params = Arguments.createMap()
    params.putString("peerId", peerId)
    params.putString("host", host)
    params.putInt("port", port)
    params.putBoolean("present", present)
    emit(EVENT_PEER, params)
  }

  private fun emitFrame(base64: String) {
    val params = Arguments.createMap()
    params.putString("base64", base64)
    emit(EVENT_FRAME, params)
  }

  private fun serveLoop(server: ServerSocket) {
    while (running) {
      val socket: Socket = try {
        server.accept()
      } catch (_: Exception) {
        break // server closed by stopLan
      }
      thread {
        try {
          val input = DataInputStream(socket.getInputStream())
          while (running) {
            val length = try {
              input.readInt()
            } catch (_: EOFException) {
              break
            }
            if (length <= 0 || length > MAX_FRAME_BYTES) break
            val bytes = ByteArray(length)
            try {
              input.readFully(bytes)
            } catch (_: EOFException) {
              break
            }
            emitFrame(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
          }
        } catch (_: Exception) {
          // A broken peer connection is not an app error.
        } finally {
          try {
            socket.close()
          } catch (_: Exception) {
          }
        }
      }
    }
  }

  @ReactMethod
  fun startLan(pubkeyHex: String, promise: Promise) {
    try {
      if (running) {
        promise.resolve(true)
        return
      }
      val context = reactApplicationContext
      val manager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
      nsdManager = manager

      val server = ServerSocket(0)
      serverSocket = server
      running = true
      thread { serveLoop(server) }

      val serviceInfo = NsdServiceInfo().apply {
        serviceName = "airplane-" + pubkeyHex.take(8)
        serviceType = SERVICE_TYPE
        port = server.localPort
        setAttribute("pk", pubkeyHex)
        setAttribute("v", "1")
      }
      try {
        manager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, registrationListener)
      } catch (_: Exception) {
        // Registration failure leaves the server up (peers can still
        // connect if they learn the port another way); discovery below
        // is what populates the peer list, and it still runs.
      }
      try {
        manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
      } catch (_: Exception) {
        // Discovery failure: no peers discovered, inbound still works.
      }
      promise.resolve(true)
    } catch (_: Exception) {
      running = false
      try {
        serverSocket?.close()
      } catch (_: Exception) {
      }
      serverSocket = null
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun stopLan(promise: Promise) {
    try {
      running = false
      val manager = nsdManager
      try {
        if (registeredService != null) {
          manager?.unregisterService(registrationListener)
        }
      } catch (_: Exception) {
      }
      try {
        manager?.stopServiceDiscovery(discoveryListener)
      } catch (_: Exception) {
      }
      try {
        serverSocket?.close()
      } catch (_: Exception) {
      }
      serverSocket = null
      registeredService = null
      nsdManager = null
      peers.clear()
      promise.resolve(true)
    } catch (_: Exception) {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun sendLan(peerId: String, base64: String, promise: Promise) {
    thread {
      try {
        val target = peers[peerId]
        if (target == null) {
          promise.resolve(false)
          return@thread
        }
        val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
        val socket = Socket()
        try {
          socket.connect(java.net.InetSocketAddress(target.first, target.second), CONNECT_TIMEOUT_MS)
          val output = DataOutputStream(socket.getOutputStream())
          output.writeInt(bytes.size)
          output.write(bytes)
          output.flush()
          promise.resolve(true)
        } finally {
          try {
            socket.close()
          } catch (_: Exception) {
          }
        }
      } catch (_: Exception) {
        promise.resolve(false)
      }
    }
  }
}

class AirplaneLanPackage : ReactPackage {
  override fun createNativeModules(
    reactContext: ReactApplicationContext,
  ): List<NativeModule> = listOf(AirplaneLanModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
