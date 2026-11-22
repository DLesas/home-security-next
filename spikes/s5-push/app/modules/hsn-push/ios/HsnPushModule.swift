// Spike S5, part 1: the app's side of the `push` module on iOS. Throwaway.
//
// - Provisioning: reads the scene's `provision.json` from the App Group container, writes the push
//   key to the keychain with the App Group as its access group (after first unlock, this device
//   only), as the real module will after `push.register`.
// - The Disarm action: a delegate of expo-notifications' NotificationCenterManager (the one
//   UNUserNotificationCenter delegate; m3-design section 6). On the "disarm" action it starts a
//   background task (expo-notifications calls the system's completion handler at once, so without
//   one the app may be suspended mid-handshake), journals the time and what the system allows
//   (`backgroundTimeRemaining`), and hands the action to JavaScript (`onDisarm`, or `pendingDisarm`
//   if JavaScript is not listening yet). `finishDisarm` posts the outcome and ends the task.
// - Inspection for the report: delivered notifications with their interruption level, settings.

import ExpoModulesCore
import ExpoNotifications
import Security
import UIKit
import UserNotifications
import os

private let group = "group.invalid.hsn.app.s5spike"
private let logger = Logger(subsystem: "invalid.hsn.s5", category: "app")

private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

private func appState() -> String {
  let read = { () -> String in
    switch UIApplication.shared.applicationState {
    case .active: return "active"
    case .inactive: return "inactive"
    case .background: return "background"
    @unknown default: return "unknown"
    }
  }
  if Thread.isMainThread { return read() }
  var out = "?"
  DispatchQueue.main.sync { out = read() }
  return out
}

func appJournal(_ event: String, _ detail: [String: Any] = [:]) {
  var line = detail
  line["atMs"] = nowMs()
  line["event"] = event
  line["pid"] = Int(getpid())
  guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]),
    let text = String(data: data, encoding: .utf8)
  else { return }
  logger.log("\(text, privacy: .public)")
  guard let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return }
  let url = folder.appendingPathComponent("app.jsonl")
  if let handle = try? FileHandle(forWritingTo: url) {
    handle.seekToEndOfFile()
    handle.write((text + "\n").data(using: .utf8)!)
    try? handle.close()
  } else {
    try? (text + "\n").data(using: .utf8)!.write(to: url)
  }
}

private func groupFile(_ name: String) -> URL? {
  FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appendingPathComponent(name)
}

private func storeKey(_ keyIdHex: String, _ key: Data) -> OSStatus {
  let base: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "hsn.push",
    kSecAttrAccount as String: keyIdHex,
    kSecAttrAccessGroup as String: group,
  ]
  SecItemDelete(base as CFDictionary)
  var add = base
  add[kSecValueData as String] = key
  add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
  return SecItemAdd(add as CFDictionary, nil)
}

private func readKey(_ keyIdHex: String) -> OSStatus {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "hsn.push",
    kSecAttrAccount as String: keyIdHex,
    kSecAttrAccessGroup as String: group,
    kSecReturnData as String: true,
  ]
  var item: CFTypeRef?
  return SecItemCopyMatching(query as CFDictionary, &item)
}

private func decodeB64url(_ text: String) -> Data? {
  var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  while s.count % 4 != 0 { s += "=" }
  return Data(base64Encoded: s)
}

/// The one delegate of ours on NotificationCenterManager; lives for the process.
final class DisarmDelegate: NotificationDelegate {
  static let shared = DisarmDelegate()
  weak var module: HsnPushModule?
  var pending: [String: Any]?
  var task: UIBackgroundTaskIdentifier = .invalid

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    guard response.actionIdentifier == "disarm" else { return false }
    let tapMs = nowMs()
    let info = response.notification.request.content.userInfo["hsn"] as? [String: Any] ?? [:]
    DispatchQueue.main.async {
      if self.task == .invalid {
        self.task = UIApplication.shared.beginBackgroundTask(withName: "hsn.disarm") {
          appJournal("app.disarm.bgExpired", ["remaining": UIApplication.shared.backgroundTimeRemaining])
          UIApplication.shared.endBackgroundTask(self.task)
          self.task = .invalid
        }
      }
      let remaining = UIApplication.shared.backgroundTimeRemaining
      appJournal("app.disarm.action", [
        "tapMs": tapMs, "state": appState(),
        "backgroundTimeRemaining": remaining.isFinite ? remaining : -1,
        "hub": info["hub"] as? String ?? "", "device": info["device"] as? Int ?? -1,
      ])
      let event: [String: Any] = ["tapMs": tapMs, "hub": info["hub"] as? String ?? "",
                                  "device": info["device"] as? Int ?? -1]
      self.pending = event
      if let module = self.module { module.sendEvent("onDisarm", event) } else { startReactNativeHeadless() }
    }
    return true
  }
}

public class HsnPushModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HsnPush")
    Events("onDisarm")

    OnCreate {
      appJournal("app.module.create", ["state": appState()])
      DisarmDelegate.shared.module = self
    }

    Function("log") { (event: String, detail: [String: Any]) in
      appJournal(event, detail)
    }

    Function("appState") { () -> String in appState() }

    /// The scene's provisioning: the push key into the keychain; the rest back to JavaScript.
    Function("provision") { () -> [String: Any] in
      guard let url = groupFile("provision.json"), let data = try? Data(contentsOf: url),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let keyId = json["pushKeyId"] as? String, let keyText = json["pushKey"] as? String,
        let key = decodeB64url(keyText)
      else { return ["ok": false] }
      let stored = storeKey(keyId, key)
      let readBack = readKey(keyId)
      appJournal("app.provision", ["keychainAdd": Int(stored), "keychainRead": Int(readBack)])
      var out = json
      out.removeValue(forKey: "pushKey")
      out["ok"] = stored == errSecSuccess
      out["keychainAdd"] = Int(stored)
      return out
    }

    /// For the vectors of step 1: the published test key, by its key id.
    Function("storeTestKey") { (keyIdHex: String, keyB64url: String) -> Int in
      guard let key = decodeB64url(keyB64url) else { return -1 }
      return Int(storeKey(keyIdHex, key))
    }

    Function("setArmed") { (hub: String, armed: Bool) in
      UserDefaults(suiteName: group)?.set(armed, forKey: "armed.\(hub)")
    }

    Function("nextSeq") { (floor: Int) -> Int in
      let defaults = UserDefaults(suiteName: group)
      let next = max(defaults?.integer(forKey: "seq") ?? 0, floor) + 1
      defaults?.set(next, forKey: "seq")
      return next
    }

    Function("pendingDisarm") { () -> [String: Any]? in
      let p = DisarmDelegate.shared.pending
      DisarmDelegate.shared.pending = nil
      return p
    }

    AsyncFunction("finishDisarm") { (ok: Bool, text: String, promise: Promise) in
      let content = UNMutableNotificationContent()
      content.body = text
      content.interruptionLevel = .active
      let request = UNNotificationRequest(identifier: "hsn.disarm.outcome.\(nowMs())", content: content, trigger: nil)
      UNUserNotificationCenter.current().add(request) { error in
        appJournal("app.disarm.outcome", ["ok": ok, "posted": error == nil])
        DispatchQueue.main.async {
          let d = DisarmDelegate.shared
          if d.task != .invalid {
            UIApplication.shared.endBackgroundTask(d.task)
            d.task = .invalid
          }
          promise.resolve(nil)
        }
      }
    }

    AsyncFunction("delivered") { (promise: Promise) in
      UNUserNotificationCenter.current().getDeliveredNotifications { notes in
        promise.resolve(notes.map { note -> [String: Any] in
          let c = note.request.content
          return [
            "id": note.request.identifier, "title": c.title, "body": c.body,
            "level": c.interruptionLevel.rawValue, "category": c.categoryIdentifier,
            "hsn": c.userInfo["hsn"] as? [String: Any] ?? [:], "dateMs": Int64(note.date.timeIntervalSince1970 * 1000),
          ]
        })
      }
    }

    AsyncFunction("removeDelivered") { (hub: String, device: Int, category: String, promise: Promise) in
      let center = UNUserNotificationCenter.current()
      center.getDeliveredNotifications { notes in
        let ids = notes.filter { note in
          let x = note.request.content.userInfo["hsn"] as? [String: Any]
          return x?["hub"] as? String == hub && x?["device"] as? Int == device && x?["category"] as? String == category
        }.map { $0.request.identifier }
        center.removeDeliveredNotifications(withIdentifiers: ids)
        promise.resolve(ids.count)
      }
    }

    AsyncFunction("settings") { (promise: Promise) in
      UNUserNotificationCenter.current().getNotificationSettings { s in
        promise.resolve([
          "authorization": s.authorizationStatus.rawValue,
          "alert": s.alertSetting.rawValue,
          "sound": s.soundSetting.rawValue,
          "criticalAlert": s.criticalAlertSetting.rawValue,
          "timeSensitive": s.timeSensitiveSetting.rawValue,
          "lockScreen": s.lockScreenSetting.rawValue,
          "scheduledDelivery": s.scheduledDeliverySetting.rawValue,
        ])
      }
    }

    /// Asks for authorization with the critical-alert option, natively, to see what the system says.
    AsyncFunction("requestCritical") { (promise: Promise) in
      UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge, .criticalAlert]) { granted, error in
        appJournal("app.requestCritical", ["granted": granted, "error": error.map { "\($0)" } ?? ""])
        promise.resolve(["granted": granted, "error": error.map { "\($0)" } ?? ""])
      }
    }

    Function("journals") { () -> [String: String] in
      var out: [String: String] = [:]
      for name in ["app.jsonl", "nse.jsonl"] {
        if let url = groupFile(name), let text = try? String(contentsOf: url, encoding: .utf8) { out[name] = text }
      }
      return out
    }
  }
}
