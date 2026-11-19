/**
 * The home screen under its state field (docs/app-design.md "Layout"): what needs attention, shown
 * only when there is something, and the doors, each a row with its name at the left and its door
 * and arming at the right. The time left in a countdown is shown once, in the state field.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useLive } from "./hub-context";
import { Body, Heading, List, ListRow, Section, TextLink } from "./parts";
import { usePhone } from "./phone-parts";

const HEALTH = ["silent", "batteryLow", "tamperOpen", "poorLink"] as const;
const DOOR = {
  open: "home.doorOpen",
  closed: "home.doorClosed",
  unknown: "home.doorUnknown",
} as const;
const ARM = {
  armed: "home.armArmed",
  disarmed: "home.armDisarmed",
  waitsForDoorToClose: "home.armWaits",
} as const;

/** Devices with something wrong, in words: battery, silence, cover, link. */
export function NeedsAttention() {
  const { t } = useTranslation();
  const devices = useLive((s) => s.devices);
  const wrong = useMemo(
    () =>
      Object.values(devices)
        .map((d) => ({ device: d, problems: HEALTH.filter((what) => d.health[what]) }))
        .filter((x) => x.problems.length > 0)
        .sort((a, b) => a.device.id - b.device.id),
    [devices],
  );
  if (wrong.length === 0) return null;
  return (
    <Section label={t("home.needsAttention")}>
      <Heading level={2}>{t("home.needsAttention")}</Heading>
      <List>
        {wrong.map(({ device, problems }) => (
          <ListRow
            key={device.id}
            testID={`attention-${String(device.id)}`}
            name={device.name}
            state={problems.map((what) => t(`devices.health.${what}`)).join(", ")}
          />
        ))}
      </List>
    </Section>
  );
}

/** Each door: its state and its arming in words (the time left is the state field's alone). */
export function Doors() {
  const { t } = useTranslation();
  const phone = usePhone();
  const sensors = useLive((s) => s.sensors);
  const devices = useLive((s) => s.devices);
  const list = useMemo(() => Object.values(sensors).sort((a, b) => a.id - b.id), [sensors]);
  return (
    <Section label={t("home.doors")}>
      <Heading level={2}>{t("home.doors")}</Heading>
      {list.length === 0 ? (
        <>
          <Body>{t(phone === undefined ? "home.noDoorsWeb" : "home.noDoors")}</Body>
          {phone === undefined ? null : <TextLink href="/device/add" label={t("pairing.add")} />}
        </>
      ) : (
        <List>
          {list.map((sensor) => (
            <ListRow
              key={sensor.id}
              testID={`sensor-${String(sensor.id)}`}
              name={devices[sensor.id]?.name ?? t("common.deviceNumber", { id: sensor.id })}
              state={t("home.doorState", { door: t(DOOR[sensor.door]), arm: t(ARM[sensor.arm]) })}
            />
          ))}
        </List>
      )}
    </Section>
  );
}
