/** The sensor page's update invitation and the final state reported by the hub. */
import { deviceUpdateObject, type AppEventBodyV2, type DeviceObject } from "@hsn/protocol/app";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { Body, Heading, Section, TextLink } from "../ui/parts";
import { currentPhoneHub } from "./phone-hub";
import { UpdateResult } from "./update-page";

type UpdateEvent = AppEventBodyV2<"deviceUpdate">;

/** Accepts the version 2 device extension retained by the shared live store. */
function updateOf(device: DeviceObject) {
  if (!("update" in device)) return undefined;
  const checked = deviceUpdateObject.safeParse(device.update);
  return checked.success ? checked.data : undefined;
}

/** Listens for the detailed update events that can explain a sensor's result. */
export function LiveDeviceUpdateSection({ device }: { readonly device: DeviceObject }) {
  const [event, setEvent] = useState<UpdateEvent>();
  const hub = currentPhoneHub();
  useEffect(() => {
    setEvent(undefined);
    return hub?.onNewEvent((change) => {
      if (change.ev === "deviceUpdate" && change.body.device === device.id) setEvent(change.body);
    });
  }, [hub, device.id]);
  return <DeviceUpdateSection device={device} event={event} hasPhoneChannel={hub !== undefined} />;
}

/** Shows the current update summary and any result detail that still matches it. */
export function DeviceUpdateSection({
  device,
  event,
  hasPhoneChannel,
}: {
  readonly device: DeviceObject;
  readonly event: UpdateEvent | undefined;
  readonly hasPhoneChannel: boolean;
}) {
  const { t } = useTranslation();
  const update = updateOf(device);
  if (update === undefined || update.state === "none") return null;
  return (
    <Section label={t("bluetoothUpdate.title")}>
      <Heading level={2}>{t("bluetoothUpdate.title")}</Heading>
      {update.held === "needsPhone" ? (
        <>
          <Body>
            {t(Platform.OS === "web" ? "bluetoothUpdate.usePhone" : "bluetoothUpdate.needsPhone")}
          </Body>
          {hasPhoneChannel ? (
            <TextLink
              href={`/device/update?device=${device.id}`}
              label={t("bluetoothUpdate.action")}
            />
          ) : null}
        </>
      ) : update.held === null ? (
        <UpdateResult
          event={event?.state === update.state ? event : update}
          version={device.firmware}
        />
      ) : (
        <Body>{t(`bluetoothUpdate.held.${update.held}`)}</Body>
      )}
    </Section>
  );
}
