// Spike S5's Expo configuration. Identifiers are the deployment's placeholders with a spike suffix
// (packages/deployment/deployment.json: invalid.hsn.app), so the spike never replaces the app's own
// development build on the simulators. S5_CRITICAL=1 declares the critical-alerts entitlement
// (the simulator does not check it against a profile; a real iPhone would need AS3).
module.exports = () => ({
  name: "HSN S5",
  slug: "s5-push-spike",
  version: "0.0.1",
  scheme: "hsn-s5",
  platforms: ["ios", "android"],
  orientation: "portrait",
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: "invalid.hsn.app.s5spike",
    supportsTablet: false,
    infoPlist: { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } },
  },
  android: {
    package: "invalid.hsn.app.s5spike",
    allowBackup: false,
    permissions: ["android.permission.POST_NOTIFICATIONS", "android.permission.ACCESS_NOTIFICATION_POLICY"],
  },
  plugins: [
    ["expo-notifications", {}],
    ["./plugins/with-hsn-push.js", { critical: process.env.S5_CRITICAL === "1" }],
  ],
});
