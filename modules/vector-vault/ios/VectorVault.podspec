require 'json'

# The version follows modules/vector-vault/package.json, which `vault-kit bump` rewrites.
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'VectorVault'
  s.version        = package['version']
  s.summary        = 'Native primitives for Vector Vault backups'
  s.description    = 'Streaming SHA-256, device facts, build flags and backup exclusion for Vector Vault export, import and cloud backup.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UIKit', 'CryptoKit', 'Network'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift}"
  s.resource_bundles = { 'VectorVaultPrivacy' => ['PrivacyInfo.xcprivacy'] }
end
