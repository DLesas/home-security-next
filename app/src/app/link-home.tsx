/** Reuses the phone's link flow for adding a home from Settings. */
import { router } from "expo-router";
import { PhoneLinkGate } from "../ui/phone-link";

/** Opens the link flow and returns to Settings on Back from its first step. */
export default function Screen() {
  return (
    <PhoneLinkGate
      backFromStart={() => {
        router.replace("/settings");
      }}
    />
  );
}
