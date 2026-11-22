/** Headless entry registered when the app bundle loads, independent of the root layout and app lock. */
import { AppRegistry } from "react-native";
import { requireNativeModule } from "expo";

interface Tap {
  hub: string;
  tag: string;
  tapMs: number;
}

/** Runs the action once and posts its result through the same Android notification identity. */
export function installPushAction(send: (hub: string, deadline: number) => Promise<boolean>): void {
  AppRegistry.registerHeadlessTask("HomePushDisarm", () => async (tap: Tap) => {
    const delivered = await send(tap.hub, tap.tapMs + 28_000).catch(() => false);
    await requireNativeModule<{ finish(tag: string, tapMs: number, ok: boolean): Promise<void> }>(
      "HomePush",
    ).finish(tap.tag, tap.tapMs, delivered);
  });
}
