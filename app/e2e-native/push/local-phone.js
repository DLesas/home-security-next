// The local stand-in issues a token and supplies a one-use link over adb reverse. Neither is logged.
import { AppState } from "react-native";
import { phoneClient } from "../../src/hub/start.native";
import { readCode } from "../../src/hub/finder";
import { pushTokens } from "../../src/platform/push-device.native";
const origin = "http://127.0.0.1:17643";
pushTokens.read = async () => ({
  ok: true,
  value: { platform: "fcm", environment: "production", token: "local-android-scene-phone" },
});

/** Link through the actual foreground client once it has mounted; a headless start never links. */
async function link() {
  for (let i = 0; i < 120; i++) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    const phone = phoneClient();
    if (!phone || AppState.currentState !== "active") continue;
    const response = await globalThis.fetch(origin + "/invite");
    if (response.status !== 200) return;
    const parsed = readCode(await response.text());
    if (!parsed.ok || parsed.value.kind !== "link") return;
    await phone.client.link(parsed.value.secret, "qr", { name: "Android phone", kind: "phone" });
    await globalThis.fetch(origin + "/linked", {
      method: "POST",
      body: phone.client.local.getState().link.kind,
    });
    return;
  }
}
void link().catch(() => undefined);
