Pod::Spec.new do |s|
  s.name           = 'HubNet'
  s.version        = '0.1.0'
  s.summary        = "Finding the hub on the home network: the browse for its mDNS record."
  s.description    = "hub-net's iOS side (app/modules/hub-net): NWBrowser and dns_sd's resolve."
  s.license        = { :type => 'Proprietary' }
  s.author         = 'hsn'
  s.homepage       = 'https://invalid.invalid'
  # NWTXTRecord's bytes (`data`) need iOS 16; Expo 58's template builds for 16.4.
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Network'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
