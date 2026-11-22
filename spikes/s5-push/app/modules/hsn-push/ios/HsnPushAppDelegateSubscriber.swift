// Spike S5, step 3: what runs at launch, before React Native (which Expo 58 starts only when a scene
// connects, and a notification action with the app closed connects none). Throwaway.
//
// Registers the Disarm delegate on expo-notifications' NotificationCenterManager at launch, so the
// action is caught whether or not React Native ever starts. Unless the App Group holds the file
// `no-headless`, it then starts React Native without a window (the factory's root view, never
// shown) so that the JavaScript Disarm can run; with the file, the template's behaviour is measured.
import Expo
import ExpoModulesCore
import ExpoNotifications
import React
import UIKit

public class HsnPushAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    appJournal("app.launch", ["state": application.applicationState.rawValue,
                              "keys": (launchOptions ?? [:]).keys.map { $0.rawValue }])
    NotificationCenterManager.shared.addDelegate(DisarmDelegate.shared)
    return true
  }
}

/// Starts React Native with no window, once, if it has not started and headless start is allowed.
var headlessView: UIView?

func startReactNativeHeadless() {
  let flag = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.invalid.hsn.app.s5spike")?
    .appendingPathComponent("no-headless")
  if let flag, FileManager.default.fileExists(atPath: flag.path) {
    appJournal("app.headless.off")
    return
  }
  guard headlessView == nil, DisarmDelegate.shared.module == nil,
    let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
    let factory = provider.reactNativeFactory
  else {
    appJournal("app.headless.notNeeded", ["module": DisarmDelegate.shared.module != nil])
    return
  }
  appJournal("app.headless.start")
  headlessView = factory.rootViewFactory.view(withModuleName: provider.reactNativeFactoryModuleName)
}
