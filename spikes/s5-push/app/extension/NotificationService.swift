// Spike S5, part 1 (docs/spikes/S5-push-part-1.md): the notification service extension. Throwaway.
//
// Opens `h` (packages/protocol/src/relay/push.ts) with CryptoKit's ChaChaPoly, finds the key by its
// key id in the keychain shared with the app (the App Group as the access group), writes the text
// from the app's own translation file (copied into this bundle by the config plugin), sets the
// interruption level, attaches the Disarm category, stores `armed` in the App Group, and removes a
// shown countdown of the same hub and device when its alarm arrives. Every step is timed into the
// App Group's `nse.jsonl`, which the report reads.
//
// Spike-only knobs, beside `h` in the payload (never in the real envelope):
//   "s5": { "level": "critical" | "timeSensitive" | "active" | "passive" | "none",
//           "tag": <text> }

import CryptoKit
import Foundation
import Security
import UserNotifications
import os

let group = Bundle.main.object(forInfoDictionaryKey: "HSNAppGroup") as? String ?? "group.invalid.hsn.app.s5spike"
let logger = Logger(subsystem: "invalid.hsn.s5", category: "nse")

func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

func journal(_ event: String, _ detail: [String: Any] = [:]) {
  var line = detail
  line["atMs"] = nowMs()
  line["event"] = event
  line["pid"] = Int(getpid())
  guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]),
    let text = String(data: data, encoding: .utf8)
  else { return }
  logger.log("\(text, privacy: .public)")
  guard let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return }
  let url = folder.appendingPathComponent("nse.jsonl")
  if let handle = try? FileHandle(forWritingTo: url) {
    handle.seekToEndOfFile()
    handle.write((text + "\n").data(using: .utf8)!)
    try? handle.close()
  } else {
    try? (text + "\n").data(using: .utf8)!.write(to: url)
  }
}

// ----- Opening h -----

enum OpenError: String, Error { case badFormat, unknownKey, decryptFailed, badPadding, badContent }

func fromBase64url(_ text: String) -> Data? {
  var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  while s.count % 4 != 0 { s += "=" }
  return Data(base64Encoded: s)
}

func hexBytes(_ hex: String) -> Data? {
  guard hex.count % 2 == 0 else { return nil }
  var out = Data()
  var at = hex.startIndex
  while at < hex.endIndex {
    let next = hex.index(at, offsetBy: 2)
    guard let b = UInt8(hex[at..<next], radix: 16) else { return nil }
    out.append(b)
    at = next
  }
  return out
}

/// The push key for a key id, from the keychain the app wrote it to.
func keyFor(_ keyIdHex: String) -> Data? {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "hsn.push",
    kSecAttrAccount as String: keyIdHex,
    kSecAttrAccessGroup as String: group,
    kSecReturnData as String: true,
  ]
  var item: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &item)
  journal("nse.keychain", ["status": Int(status)])
  return status == errSecSuccess ? item as? Data : nil
}

func open(_ h: String) -> Result<[String: Any], OpenError> {
  let parts = h.split(separator: ".", omittingEmptySubsequences: false)
  guard parts.count == 3, parts[0] == "1", parts[1].count == 16, parts[2].count == 1744,
    parts[1].allSatisfy({ "0123456789abcdef".contains($0) }),
    parts[2].allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }),
    let keyId = hexBytes(String(parts[1])), let sealed = fromBase64url(String(parts[2])),
    sealed.count == 12 + 1280 + 16
  else { return .failure(.badFormat) }
  guard let keyBytes = keyFor(String(parts[1])), keyBytes.count == 32 else { return .failure(.unknownKey) }
  var aad = Data("hsn-push/1".utf8)
  aad.append(0)
  aad.append(keyId)
  let plain: Data
  do {
    let box = try ChaChaPoly.SealedBox(
      nonce: ChaChaPoly.Nonce(data: sealed.prefix(12)),
      ciphertext: sealed.dropFirst(12).dropLast(16),
      tag: sealed.suffix(16))
    plain = try ChaChaPoly.open(box, using: SymmetricKey(data: keyBytes), authenticating: aad)
  } catch { return .failure(.decryptFailed) }
  guard let last = plain.lastIndex(where: { $0 != 0 }), plain[last] == 0x80 else { return .failure(.badPadding) }
  guard let json = try? JSONSerialization.jsonObject(with: plain.prefix(upTo: last)) as? [String: Any],
    json["v"] as? Int == 1, json["hub"] is String, json["n"] is [String: Any]
  else { return .failure(.badContent) }
  return .success(json)
}

// ----- The words: the app's translation file -----

func loadJson(_ name: String) -> [String: Any] {
  guard let url = Bundle.main.url(forResource: name, withExtension: "json"),
    let data = try? Data(contentsOf: url),
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { return [:] }
  return json
}

let common = loadJson("common")
let pushWords = loadJson("push-words")

func word(_ path: String, _ values: [String: String] = [:]) -> String? {
  var node: Any? = common
  for part in path.split(separator: ".") { node = (node as? [String: Any])?[String(part)] }
  guard var text = node as? String else { return nil }
  for (k, v) in values { text = text.replacingOccurrences(of: "{{\(k)}}", with: v) }
  return text
}

func pushWord(_ key: String) -> String? { pushWords[key] as? String }

func words(_ c: [String: Any]) -> (title: String, body: String) {
  let n = c["n"] as? [String: Any] ?? [:]
  let kind = n["kind"] as? String ?? ""
  let names = c["names"] as? [String: Any] ?? [:]
  if kind == "hub_unreachable" || kind == "hub_back" {
    return (pushWord("\(kind).title") ?? kind, pushWord("\(kind).text") ?? "")
  }
  let category = n["category"] as? String ?? ""
  let what = word("notifications.category.\(category)") ?? pushWord("unknown") ?? kind
  let title = word("banner.\(category)") ?? what
  var body = what
  if let device = names["device"] as? String {
    body = word("notifications.about", ["what": what, "device": device]) ?? body
  }
  if c["delayed"] as? Bool == true, let late = word("notifications.delayed") { body += " " + late }
  return (title, body)
}

// ----- The extension -----

class NotificationService: UNNotificationServiceExtension {
  var contentHandler: ((UNNotificationContent) -> Void)?
  var bestAttempt: UNMutableNotificationContent?
  var startedMs: Int64 = 0

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    startedMs = nowMs()
    self.contentHandler = contentHandler
    let content = request.content.mutableCopy() as! UNMutableNotificationContent
    bestAttempt = content
    let knobs = content.userInfo["s5"] as? [String: Any] ?? [:]
    journal("nse.start", ["id": request.identifier, "tag": knobs["tag"] as? String ?? "",
                          "levelIn": content.interruptionLevel.rawValue])

    guard let h = content.userInfo["h"] as? String else {
      journal("nse.noH")
      contentHandler(content)
      return
    }
    let opened = open(h)
    guard case .success(let c) = opened else {
      if case .failure(let why) = opened { journal("nse.refused", ["why": why.rawValue]) }
      // The envelope's own placeholder (`loc-key`) is shown, as when the extension fails.
      contentHandler(content)
      return
    }
    let n = c["n"] as? [String: Any] ?? [:]
    let hub = c["hub"] as? String ?? ""
    let kind = n["kind"] as? String ?? ""
    let device = n["device"] as? Int
    let category = n["category"] as? String ?? ""
    let (title, body) = words(c)
    content.title = title
    content.body = body
    let actions = c["actions"] as? [String] ?? []
    if actions.contains("disarm") { content.categoryIdentifier = "hsn.disarm" }
    else if actions.contains("armAway") { content.categoryIdentifier = "hsn.armAway" }
    var info = content.userInfo
    info["hsn"] = ["hub": hub, "device": device ?? -1, "category": category, "kind": kind,
                   "seq": n["seq"] as? Int ?? 0]
    info.removeValue(forKey: "h")
    content.userInfo = info
    content.threadIdentifier = hub

    // Loudness, decided here (envelope A): critical for n.critical, and for hub_unreachable when
    // this phone last saw the home armed (D96).
    let defaults = UserDefaults(suiteName: group)
    let lastArmed = defaults?.bool(forKey: "armed.\(hub)") ?? false
    let critical = (n["critical"] as? Bool ?? false) || (kind == "hub_unreachable" && lastArmed)
    let level = knobs["level"] as? String ?? (critical ? "critical" : "active")
    switch level {
    case "critical":
      content.interruptionLevel = .critical
      content.sound = UNNotificationSound.defaultCriticalSound(withAudioVolume: 1.0)
    case "timeSensitive":
      content.interruptionLevel = .timeSensitive
      content.sound = .default
    case "passive": content.interruptionLevel = .passive
    case "active": content.interruptionLevel = .active
    default: break
    }
    if kind != "hub_unreachable" && kind != "hub_back" {
      defaults?.set(c["armed"] as? Bool ?? false, forKey: "armed.\(hub)")
    }
    journal("nse.opened", ["kind": kind, "title": title, "body": body, "levelSet": content.interruptionLevel.rawValue,
                           "lastArmed": lastArmed, "category": content.categoryIdentifier])

    // Countdown replaced by its alarm: remove the shown countdown of the same hub and device.
    if category == "alarm", let device {
      let center = UNUserNotificationCenter.current()
      center.getDeliveredNotifications { delivered in
        let ids = delivered.filter { note in
          let x = note.request.content.userInfo["hsn"] as? [String: Any]
          return x?["hub"] as? String == hub && x?["device"] as? Int == device && x?["category"] as? String == "countdown"
        }.map { $0.request.identifier }
        journal("nse.replace", ["delivered": delivered.count, "removing": ids])
        center.removeDeliveredNotifications(withIdentifiers: ids)
        self.finish(content)
      }
      return
    }
    finish(content)
  }

  func finish(_ content: UNNotificationContent) {
    journal("nse.done", ["ms": nowMs() - startedMs])
    contentHandler?(content)
    contentHandler = nil
  }

  override func serviceExtensionTimeWillExpire() {
    journal("nse.expire", ["ms": nowMs() - startedMs])
    if let handler = contentHandler, let content = bestAttempt { handler(content) }
    contentHandler = nil
  }
}
