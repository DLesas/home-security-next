// hub-net on Android: the browse for the hub's `_hsn-hub._tcp` record (m3-design.md section 2,
// "Our module, `hub-net`"). `src/contract.ts` is the contract with the TypeScript side; what the
// record means is read there, not here.
//
// - The browse is the system's own service discovery, `NsdManager` (the SDK's
//   `sources/android-37.0/android/net/nsd/NsdManager.java` was read): `discoverServices` finds and
//   loses services; each found service is followed with `registerServiceInfoCallback` on Android
//   14 (API 34) and later, which reports its addresses, port and TXT record as they change and
//   when it goes, and is resolved once with `resolveService` before that, one at a time (older
//   NsdManager refuses a second resolve while one is open).
// - Android 17 (API 37) refuses discovery and resolution to an app without
//   `ACCESS_LOCAL_NETWORK` with `FAILURE_PERMISSION_DENIED` (7), for apps that target it; that
//   code is passed on, and the TypeScript side calls it a refusal. The system's picker
//   (`DiscoveryRequest.FLAG_SHOW_PICKER`), which grants one service without the permission, is
//   not used.
// - Everything runs on one thread of the module's own: NsdManager's callbacks are moved onto it,
//   or given it as their executor, so no state is shared across threads. Nothing polls. The
//   browse runs from `start` to `stop`, or until discovery fails.
// - Nothing here asks the person anything, but `ask`, which a page calls after explaining
//   (docs/app-design.md, "On a phone", rule 7): React Native asks for `ACCESS_LOCAL_NETWORK` in a
//   debug build only (docs/spikes/P0-phone-build.md, section 6), so a release build asks here.
package app.hsn.hubnet

import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import app.hsn.hubnet.safe.attempt
import app.hsn.hubnet.safe.attempted
import expo.modules.interfaces.permissions.PermissionsResponse
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

private const val EVENT = "hubNet"
private const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"

/** Android 17, the first with `ACCESS_LOCAL_NETWORK`. */
private const val LOCAL_NETWORK_API = 37

class HubNetModule : Module() {
  private val thread: ExecutorService = Executors.newSingleThreadExecutor()

  /** The browse running, if any. Touched on `thread` only. */
  private var running: HubBrowse? = null

  override fun definition() = ModuleDefinition {
    Name("HubNet")
    Events(EVENT)

    AsyncFunction("start") { serviceType: String, session: Int, promise: Promise ->
      val context = appContext.reactContext
      thread.execute {
        running?.stop()
        running = null
        val nsd = context?.getSystemService(Context.NSD_SERVICE) as? NsdManager
        if (nsd == null) {
          promise.resolve(mapOf("refused" to "unsupported", "code" to 0))
          return@execute
        }
        val browse = HubBrowse(nsd, serviceType, session, thread) { body -> sendEvent(EVENT, body) }
        running = browse
        browse.start(localNetworkPresent(context))
        promise.resolve(mapOf("started" to true))
      }
    }

    AsyncFunction("stop") { session: Int, promise: Promise ->
      thread.execute {
        if (running?.session == session) {
          running?.stop()
          running = null
        }
        promise.resolve(null)
      }
    }

    AsyncFunction("permission") { promise: Promise -> permission(promise, ask = false) }

    AsyncFunction("ask") { promise: Promise -> permission(promise, ask = true) }

    OnDestroy {
      thread.execute {
        running?.stop()
        running = null
      }
      thread.shutdown()
    }
  }

  /** Reads `ACCESS_LOCAL_NETWORK`, or asks for it, through Expo's permission service. */
  private fun permission(promise: Promise, ask: Boolean) {
    if (Build.VERSION.SDK_INT < LOCAL_NETWORK_API) {
      promise.resolve(mapOf("state" to "granted", "canAskAgain" to true))
      return
    }
    val service = appContext.permissions
    val answer = PermissionsResponseListener { result ->
      promise.resolve(answerOf(result[LOCAL_NETWORK]))
    }
    val sent =
      service != null &&
        attempted {
          if (ask) service.askForPermissions(answer, LOCAL_NETWORK)
          else service.getPermissions(answer, LOCAL_NETWORK)
        }
    if (!sent) promise.resolve(mapOf("state" to "undetermined", "canAskAgain" to true))
  }
}

private fun answerOf(response: PermissionsResponse?): Map<String, Any> {
  val state =
    when (response?.status) {
      PermissionsStatus.GRANTED -> "granted"
      PermissionsStatus.DENIED -> "denied"
      else -> "undetermined"
    }
  return mapOf("state" to state, "canAskAgain" to (response?.canAskAgain ?: true))
}

/**
 * Whether the phone is on a Wi-Fi or Ethernet network, which mDNS needs; null when it cannot be
 * read (no `ACCESS_NETWORK_STATE`), and then nothing is said.
 */
private fun localNetworkPresent(context: Context): Boolean? {
  if (context.checkSelfPermission("android.permission.ACCESS_NETWORK_STATE") !=
    PackageManager.PERMISSION_GRANTED
  ) return null
  val connectivity = context.getSystemService(ConnectivityManager::class.java) ?: return null
  return attempt {
    @Suppress("DEPRECATION") // One read of every network; a callback would outlive the browse.
    connectivity.allNetworks.any { network ->
      val capabilities = connectivity.getNetworkCapabilities(network)
      capabilities != null &&
        (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
          capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
    }
  }
}

/** One browse: discovery, and a follower per service found. Confined to `thread`. */
internal class HubBrowse(
  private val nsd: NsdManager,
  private val serviceType: String,
  val session: Int,
  private val thread: Executor,
  private val emit: (Map<String, Any?>) -> Unit,
) {
  private val services = HashMap<String, HubService>()
  /** Before API 34: services waiting for the one resolve NsdManager allows at a time. */
  private val waiting = ArrayDeque<HubService>()
  private var resolving: HubService? = null
  private var stopped = false
  private var discovering = false

  private val listener =
    object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(type: String) = on { state("ready", "other", 0) }

      override fun onStartDiscoveryFailed(type: String, code: Int) = on {
        discovering = false
        state("failed", "nsd", code)
        stop()
      }

      override fun onDiscoveryStopped(type: String) = Unit

      override fun onStopDiscoveryFailed(type: String, code: Int) = Unit

      override fun onServiceFound(info: NsdServiceInfo) = on { found(info) }

      override fun onServiceLost(info: NsdServiceInfo) = on {
        val name = info.serviceName
        if (name != null) lost(name)
      }
    }

  /** Runs `step` on the browse's thread, unless the browse has stopped. */
  private fun on(step: () -> Unit) {
    thread.execute { if (!stopped) step() }
  }

  fun start(local: Boolean?) {
    if (local != null) emit(mapOf("kind" to "network", "session" to session, "local" to local))
    discovering = attempted { nsd.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener) }
    if (!discovering) {
      state("failed", "other", 0)
      stopped = true
    }
  }

  fun stop() {
    if (stopped) return
    stopped = true
    if (discovering) attempted { nsd.stopServiceDiscovery(listener) }
    discovering = false
    for (service in services.values) service.stop()
    services.clear()
    waiting.clear()
    resolving = null
  }

  private fun state(state: String, domain: String, code: Int) {
    if (stopped) return
    emit(
      mapOf(
        "kind" to "state",
        "session" to session,
        "state" to state,
        "domain" to domain,
        "code" to code,
      ),
    )
  }

  /** A follower's refusal or failure, NsdManager's code: told as waiting, the browse goes on. */
  fun followFailed(code: Int) = state("waiting", "nsd", code)

  /** A follower that could not even be asked for (NsdManager threw): waiting, the browse goes on. */
  fun followRefused() = state("waiting", "other", 0)

  private fun found(info: NsdServiceInfo) {
    val name = info.serviceName ?: return
    if (services.containsKey(name)) return
    val service = HubService(nsd, info, name, thread, this)
    services[name] = service
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) service.follow()
    else {
      waiting.addLast(service)
      resolveNext()
    }
  }

  /** A service gone, told once: discovery and its follower may both say so. */
  fun lost(name: String) {
    if (stopped) return
    val service = services.remove(name) ?: return
    service.stop()
    emit(mapOf("kind" to "lost", "session" to session, "name" to name))
  }

  /** Before API 34: the next resolve, once the last has answered. */
  fun resolveNext() {
    if (stopped || resolving != null) return
    val next = waiting.removeFirstOrNull() ?: return
    if (!services.containsValue(next)) return resolveNext()
    resolving = next
    next.resolveOnce()
  }

  fun resolveDone(service: HubService) {
    if (resolving === service) resolving = null
    resolveNext()
  }

  @Suppress("DEPRECATION") // `host`, the one address NsdManager gives before API 34.
  fun report(name: String, info: NsdServiceInfo) {
    if (stopped || !services.containsKey(name)) return
    val addresses =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
        info.hostAddresses.mapNotNull { it.hostAddress }
      else listOfNotNull(info.host?.hostAddress)
    val entries = info.attributes.mapValues { (_, value) -> value?.map { it.toInt() and 0xff } }
    emit(
      mapOf(
        "kind" to "service",
        "session" to session,
        "name" to name,
        "port" to info.port,
        "addresses" to addresses,
        "txt" to mapOf("entries" to entries),
      ),
    )
  }
}

/** One service found, followed as it changes (API 34 and later) or resolved once (before). */
internal class HubService(
  private val nsd: NsdManager,
  private val info: NsdServiceInfo,
  private val name: String,
  private val thread: Executor,
  private val browse: HubBrowse,
) {
  private var callback: NsdManager.ServiceInfoCallback? = null
  private var stopped = false

  private fun on(step: () -> Unit) {
    thread.execute { if (!stopped) step() }
  }

  fun follow() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return
    val follower =
      object : NsdManager.ServiceInfoCallback {
        override fun onServiceInfoCallbackRegistrationFailed(code: Int) = on {
          browse.followFailed(code)
        }

        override fun onServiceUpdated(updated: NsdServiceInfo) = on { browse.report(name, updated) }

        override fun onServiceLost() = on { browse.lost(name) }

        override fun onServiceInfoCallbackUnregistered() = Unit
      }
    callback = follower
    if (!attempted { nsd.registerServiceInfoCallback(info, thread, follower) }) {
      callback = null
      browse.followRefused()
    }
  }

  @Suppress("DEPRECATION") // resolveService is how NsdManager resolves before API 34.
  fun resolveOnce() {
    // Its answers free the one resolve for the next service even if this one is gone by then.
    val listener =
      object : NsdManager.ResolveListener {
        override fun onServiceResolved(resolved: NsdServiceInfo) =
          thread.execute {
            if (!stopped) browse.report(name, resolved)
            browse.resolveDone(this@HubService)
          }

        override fun onResolveFailed(failed: NsdServiceInfo, code: Int) =
          thread.execute {
            if (!stopped) browse.followFailed(code)
            browse.resolveDone(this@HubService)
          }
      }
    if (!attempted { nsd.resolveService(info, listener) }) {
      browse.followRefused()
      browse.resolveDone(this)
    }
  }

  fun stop() {
    stopped = true
    val follower = callback ?: return
    callback = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
      attempted { nsd.unregisterServiceInfoCallback(follower) }
  }
}
