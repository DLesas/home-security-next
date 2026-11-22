# Spike S5's `push` module, the app's side (the extension is a target of its own, added by the
# config plugin). Throwaway.
Pod::Spec.new do |s|
  s.name           = 'HsnPush'
  s.version        = '0.0.1'
  s.summary        = 'Spike S5: push key storage and the Disarm action'
  s.license        = { :type => 'Proprietary' }
  s.author         = 'hsn'
  s.homepage       = 'https://invalid.invalid'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoNotifications'
  s.dependency 'Expo'
  s.dependency 'React-RCTAppDelegate'
  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
