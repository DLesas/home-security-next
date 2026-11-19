// hub-net on iOS: the browse for the hub's `_hsn-hub._tcp` record (m3-design.md section 2,
// "Our module, `hub-net`"). `src/contract.ts` is the contract with the TypeScript side; what the
// record means is read there, not here.
//
// - The browse is the Network framework's `NWBrowser`, with the TXT record (`bonjourWithTXTRecord`):
//   it is not deprecated (Foundation's `NetService` is marked "to be deprecated" in the iOS 27.2
//   SDK, `NSNetServices.h`), and it reports the local network refusal as a state, waiting with
//   dns_sd's `kDNSServiceErr_PolicyDenied`, which `NetService` has no way to say. Both are covered
//   by the same `NSLocalNetworkUsageDescription` and `NSBonjourServices` (app.config.ts).
// - The Network framework gives no address for a found service without connecting to it, so each
//   service is resolved with dns_sd, the system's own Bonjour API, which `NWBrowser` itself sits
//   on: `DNSServiceResolve` for its host and port, then `DNSServiceGetAddrInfo` for the host's IPv4
//   and IPv6 addresses. Each is a long-lived query that calls back as its answers change.
// - Everything runs on one serial queue: the browser, the path monitor and the dns_sd queries
//   deliver there, and the module's functions run there (`runOnQueue`), so no state is shared
//   across threads. Nothing polls. The browse runs from `start` to `stop`, or until it fails.
// - Nothing here asks the person anything, and nothing is thrown: every failure is an event.
//
// The local network permission cannot be read or asked for on iOS (Apple's TN3179): `permission`
// says `unreadable`, and the system asks by itself at the first browse or connection.

import Darwin
import ExpoModulesCore
import Network
import dnssd

public final class HubNetModule: Module {
  private let queue = DispatchQueue(label: "hsn.hub-net")
  /// The browse running, if any. Touched on `queue` only.
  private var running: HubBrowse?

  public func definition() -> ModuleDefinition {
    Name("HubNet")
    Events("hubNet")

    AsyncFunction("start") { (serviceType: String, session: Int) -> [String: Any] in
      self.running?.cancel()
      let browse = HubBrowse(serviceType: serviceType, session: session, queue: self.queue) {
        [weak self] body in
        self?.sendEvent("hubNet", body)
      }
      self.running = browse
      browse.start()
      return ["started": true]
    }.runOnQueue(queue)

    AsyncFunction("stop") { (session: Int) -> [String: Any] in
      if let browse = self.running, browse.session == session {
        browse.cancel()
        self.running = nil
      }
      return [:]
    }.runOnQueue(queue)

    AsyncFunction("permission") { () -> [String: Any] in
      return ["state": "unreadable", "canAskAgain": true]
    }

    AsyncFunction("ask") { () -> [String: Any] in
      return ["state": "unreadable", "canAskAgain": true]
    }

    OnDestroy {
      self.queue.async {
        self.running?.cancel()
        self.running = nil
      }
    }
  }
}

/// An error's domain and code, as `contract.ts` names them.
private func codeOf(_ error: NWError?) -> (String, Int) {
  guard let error else { return ("other", 0) }
  switch error {
  case .dns(let code): return ("dns", Int(code))
  case .posix(let code): return ("posix", Int(code.rawValue))
  default: return ("other", error.errorCode)
  }
}

/// One browse: the browser, a path monitor for "is there Wi-Fi or Ethernet", and a resolve per
/// service found. Confined to its queue.
final class HubBrowse: @unchecked Sendable {
  let session: Int
  private let serviceType: String
  private let queue: DispatchQueue
  private let emit: ([String: Any?]) -> Void
  private var browser: NWBrowser?
  private var monitor: NWPathMonitor?
  private var services: [String: HubService] = [:]
  private var cancelled = false

  init(
    serviceType: String, session: Int, queue: DispatchQueue,
    emit: @escaping ([String: Any?]) -> Void
  ) {
    self.serviceType = serviceType
    self.session = session
    self.queue = queue
    self.emit = emit
  }

  func start() {
    let parameters = NWParameters()
    parameters.includePeerToPeer = false
    let browser = NWBrowser(
      for: .bonjourWithTXTRecord(type: serviceType, domain: "local."), using: parameters)
    browser.stateUpdateHandler = { [weak self] state in self?.stateChanged(state) }
    browser.browseResultsChangedHandler = { [weak self] _, changes in self?.resultsChanged(changes) }
    self.browser = browser
    browser.start(queue: queue)

    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { [weak self] path in self?.pathChanged(path) }
    self.monitor = monitor
    monitor.start(queue: queue)
  }

  func cancel() {
    cancelled = true
    browser?.cancel()
    browser = nil
    monitor?.cancel()
    monitor = nil
    for service in services.values { service.cancel() }
    services.removeAll()
  }

  private func send(_ body: [String: Any?]) {
    if !cancelled { emit(body) }
  }

  private func stateChanged(_ state: NWBrowser.State) {
    switch state {
    case .ready:
      sendState("ready", nil)
    case .waiting(let error):
      sendState("waiting", error)
    case .failed(let error):
      sendState("failed", error)
      cancel()
    case .setup, .cancelled:
      break
    @unknown default:
      break
    }
  }

  private func sendState(_ state: String, _ error: NWError?) {
    let (domain, code) = codeOf(error)
    send(["kind": "state", "session": session, "state": state, "domain": domain, "code": code])
  }

  /// A dns_sd query's refusal or failure, told as a waiting state: the browse goes on.
  fileprivate func queryFailed(_ code: DNSServiceErrorType) {
    send([
      "kind": "state", "session": session, "state": "waiting", "domain": "dns", "code": Int(code),
    ])
  }

  private func pathChanged(_ path: NWPath) {
    let local = path.availableInterfaces.contains { $0.type == .wifi || $0.type == .wiredEthernet }
    send(["kind": "network", "session": session, "local": local])
  }

  private func resultsChanged(_ changes: Set<NWBrowser.Result.Change>) {
    for change in changes {
      switch change {
      case .added(let result):
        seen(result)
      case .changed(_, let result, _):
        seen(result)
      case .removed(let result):
        gone(result)
      case .identical:
        break
      @unknown default:
        break
      }
    }
  }

  private func seen(_ result: NWBrowser.Result) {
    guard case .service(let name, let type, let domain, _) = result.endpoint else { return }
    var txt: [UInt8] = []
    if case .bonjour(let record) = result.metadata { txt = [UInt8](record.data) }
    if let known = services[name] {
      known.txt = txt
      known.report()
      return
    }
    let service = HubService(
      name: name, type: type, domain: domain, browse: self, queue: queue, txt: txt)
    services[name] = service
    service.resolve()
  }

  private func gone(_ result: NWBrowser.Result) {
    guard case .service(let name, _, _, _) = result.endpoint else { return }
    services.removeValue(forKey: name)?.cancel()
    send(["kind": "lost", "session": session, "name": name])
  }

  fileprivate func report(_ service: HubService, port: Int, addresses: [String]) {
    send([
      "kind": "service", "session": session, "name": service.name, "port": port,
      "addresses": addresses, "txt": ["raw": service.txt.map { Int($0) }],
    ])
  }
}

private let noError = DNSServiceErrorType(kDNSServiceErr_NoError)

/// dns_sd's answers, as C functions: each finds its service through the context pointer, which
/// stays valid until the service deallocates its queries (on the same queue, so no answer can
/// come after).
private let resolveReply: DNSServiceResolveReply = {
  _, _, interfaceIndex, error, _, host, port, _, _, context in
  guard let context else { return }
  let service = Unmanaged<HubService>.fromOpaque(context).takeUnretainedValue()
  service.resolved(
    error: error, host: host.map { String(cString: $0) }, port: Int(UInt16(bigEndian: port)),
    interfaceIndex: interfaceIndex)
}

private let addressReply: DNSServiceGetAddrInfoReply = {
  _, flags, _, error, _, address, _, context in
  guard let context else { return }
  let service = Unmanaged<HubService>.fromOpaque(context).takeUnretainedValue()
  service.addressChanged(flags: flags, error: error, address: address)
}

/// A service found: its TXT record from the browse, its host and port from `DNSServiceResolve`,
/// its addresses from `DNSServiceGetAddrInfo`. Confined to its queue.
final class HubService {
  let name: String
  var txt: [UInt8]
  private let type: String
  private let domain: String
  private weak var browse: HubBrowse?
  private let queue: DispatchQueue
  private var resolveRef: DNSServiceRef?
  private var addressRef: DNSServiceRef?
  private var host: String?
  private var port: Int?
  private var addresses: [String] = []

  init(
    name: String, type: String, domain: String, browse: HubBrowse, queue: DispatchQueue,
    txt: [UInt8]
  ) {
    self.name = name
    self.type = type
    self.domain = domain
    self.browse = browse
    self.queue = queue
    self.txt = txt
  }

  private var context: UnsafeMutableRawPointer { Unmanaged.passUnretained(self).toOpaque() }

  func resolve() {
    var ref: DNSServiceRef?
    let error = DNSServiceResolve(&ref, 0, 0, name, type, domain, resolveReply, context)
    guard error == noError, let ref else {
      browse?.queryFailed(error)
      return
    }
    DNSServiceSetDispatchQueue(ref, queue)
    resolveRef = ref
  }

  func cancel() {
    if let ref = resolveRef { DNSServiceRefDeallocate(ref) }
    resolveRef = nil
    stopAddresses()
  }

  private func stopAddresses() {
    if let ref = addressRef { DNSServiceRefDeallocate(ref) }
    addressRef = nil
    addresses = []
  }

  /// Tells the browse what is known, once the port is.
  func report() {
    guard let port else { return }
    browse?.report(self, port: port, addresses: addresses)
  }

  func resolved(error: DNSServiceErrorType, host: String?, port: Int, interfaceIndex: UInt32) {
    guard error == noError, let host else {
      browse?.queryFailed(error)
      return
    }
    self.port = port
    if host != self.host {
      self.host = host
      stopAddresses()
      var ref: DNSServiceRef?
      let protocols = DNSServiceProtocol(kDNSServiceProtocol_IPv4 | kDNSServiceProtocol_IPv6)
      let started = DNSServiceGetAddrInfo(
        &ref, 0, interfaceIndex, protocols, host, addressReply, context)
      if started == noError, let ref {
        DNSServiceSetDispatchQueue(ref, queue)
        addressRef = ref
      } else {
        browse?.queryFailed(started)
      }
    }
    report()
  }

  func addressChanged(
    flags: DNSServiceFlags, error: DNSServiceErrorType, address: UnsafePointer<sockaddr>?
  ) {
    if error == noError, let address, let text = numericHost(address) {
      if flags & DNSServiceFlags(kDNSServiceFlagsAdd) != 0 {
        if !addresses.contains(text) { addresses.append(text) }
      } else {
        addresses.removeAll { $0 == text }
      }
    } else if error != noError && error != DNSServiceErrorType(kDNSServiceErr_NoSuchRecord) {
      // No AAAA record (NoSuchRecord) is an ordinary answer; anything else is told.
      browse?.queryFailed(error)
    }
    if flags & DNSServiceFlags(kDNSServiceFlagsMoreComing) == 0 { report() }
  }
}

/// An address as text, a link-local IPv6 address with its zone (`fe80::1%en0`).
private func numericHost(_ address: UnsafePointer<sockaddr>) -> String? {
  var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
  let length = socklen_t(address.pointee.sa_len)
  let found = getnameinfo(address, length, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
  return found == 0 ? String(cString: host) : nil
}
