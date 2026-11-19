/** Keeps a pairing or transfer screen awake via Expo's already autolinked native module. */
import { requireOptionalNativeModule } from "expo";
import { useEffect, useId } from "react";

interface KeepAwake {
  activate(tag: string): Promise<unknown>;
  deactivate(tag: string): Promise<unknown>;
}

/** Releases the tag on departure, including when activation was still pending. */
export function useFlowAwake(active: boolean): void {
  const tag = useId();
  useEffect(() => {
    if (!active) return;
    const awake = requireOptionalNativeModule<KeepAwake>("ExpoKeepAwake");
    if (awake === null) return;
    const gained = awake.activate(tag).then(
      () => true,
      () => false,
    );
    return () => {
      void gained.then((on) => (on ? awake.deactivate(tag) : false)).catch(() => undefined);
    };
  }, [active, tag]);
}
