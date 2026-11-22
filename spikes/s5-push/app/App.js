// Spike S5's one screen: set up, then show what the system says. Throwaway.
import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import * as Notifications from "expo-notifications";
import HsnPush from "./modules/hsn-push";

// The published test vector's key (packages/protocol/vectors/relay-push.json), for step 1.
const VECTOR_KEY_ID = "97bff92d9a6691ec";
const VECTOR_KEY = "86dv6RNpl35gcFyFyR_NrU9F5Pb_fb-yMfEsv93VAnY";

// Shown while the app is in front too, so the screen can be photographed.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

async function setUp() {
  const out = {};
  // The Disarm category, owned by expo-notifications (it sets the system's whole list).
  await Notifications.setNotificationCategoryAsync("hsn.disarm", [
    {
      identifier: "disarm",
      buttonTitle: "Disarm",
      options: { opensAppToForeground: false, isAuthenticationRequired: false, isDestructive: false },
    },
  ]);
  await Notifications.setNotificationCategoryAsync("hsn.armAway", [
    { identifier: "armAway", buttonTitle: "Arm away", options: { opensAppToForeground: true } },
  ]);
  out.permission = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: true, allowCriticalAlerts: false },
  });
  if (Platform.OS === "android") out.channels = HsnPush.createChannels();
  out.testKey = HsnPush.storeTestKey(VECTOR_KEY_ID, VECTOR_KEY);
  const p = HsnPush.provision();
  out.provisioned = { ok: p.ok, relayUrl: p.relayUrl ?? null, client: p.client ?? null, keychainAdd: p.keychainAdd ?? null };
  HsnPush.log("js.setUp", { testKey: out.testKey, provisioned: out.provisioned.ok });
  return out;
}

function Button({ label, onPress }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{ backgroundColor: "#2d4a3e", padding: 12, margin: 4, borderRadius: 6 }}
    >
      <Text style={{ color: "white", fontSize: 16 }}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  const [text, setText] = useState("Setting up…");
  const show = (value) => setText(JSON.stringify(value, null, 1));
  useEffect(() => {
    setUp().then(show, (e) => setText(String(e)));
  }, []);
  return (
    <View style={{ flex: 1, paddingTop: 60, paddingHorizontal: 12, backgroundColor: "#f4f1ea" }}>
      <Text style={{ fontSize: 22, marginBottom: 8 }}>S5 push spike</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        <Button label="Set up" onPress={() => setUp().then(show, (e) => setText(String(e)))} />
        <Button label="Delivered" onPress={() => HsnPush.delivered().then(show)} />
        <Button label="Settings" onPress={() => HsnPush.settings().then(show)} />
        {Platform.OS === "ios" ? (
          <Button label="Ask critical" onPress={() => HsnPush.requestCritical().then(show)} />
        ) : (
          <Button label="DND access" onPress={() => show(HsnPush.askPolicyAccess())} />
        )}
      </View>
      <ScrollView style={{ flex: 1, marginTop: 8 }}>
        <Text selectable style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 11 }}>
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}
