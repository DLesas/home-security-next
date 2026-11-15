/**
 * Devices (m2-design.md sections 7 and 8; AP4, D100, PR5): the list with each device's health in
 * words (battery %, signal, silence, cover, poor link, when last heard and by which gateway), the
 * notice that a device was added (a gateway plugged in is added on its own), and adding a board
 * over USB from the hub computer's browser.
 */
import {
  type AppOpReply,
  deviceNameValue,
  type DeviceObject,
  type SnapshotObject,
} from "@hsn/protocol/app";
import { useQuery } from "@tanstack/react-query";
import { Link } from "expo-router";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { dismissAdded } from "../state/live";
import { formatTime } from "./format";
import { useAction, useHub, useLive } from "./hub-context";
import { Body, Button, Choice, Failure, Field, Heading, Notice, Section } from "./parts";
import { styles } from "./theme";

const HEALTH = ["silent", "batteryLow", "tamperOpen", "poorLink"] as const;

function healthWords(t: (key: string) => string, device: DeviceObject): string {
  const problems = HEALTH.filter((what) => device.health[what]).map((what) =>
    t(`devices.health.${what}`),
  );
  return problems.length === 0 ? t("devices.healthy") : problems.join(" · ");
}

/** A device's readings and health, in words (AP4). */
export function DeviceItemFacts({
  device,
  gateway,
}: {
  readonly device: DeviceObject;
  readonly gateway?: SnapshotObject["gateways"][number] | undefined;
}) {
  const { t, i18n } = useTranslation();
  const hub = useLive((s) => s.hub);
  const devices = useLive((s) => s.devices);
  const facts = [
    t(`devices.role.${device.role}`),
    t(`devices.state.${device.state}`),
    device.batteryPercent === null
      ? t("devices.batteryNone")
      : t("devices.battery", { percent: device.batteryPercent }),
    device.signal === null
      ? t("devices.signalNone")
      : t("devices.signal", { rssi: device.signal.rssiDbm }),
    ...(device.temperatureC === null
      ? []
      : [t("devices.temperature", { celsius: device.temperatureC })]),
    t("devices.firmware", { version: device.firmware }),
  ];
  const heardBy =
    device.heardBy === null
      ? undefined
      : (devices[device.heardBy]?.name ?? t("common.deviceNumber", { id: device.heardBy }));
  return (
    <>
      <Text style={styles.body}>{facts.join(" · ")}</Text>
      <Text style={styles.body}>
        {healthWords(t, device)}
        {gateway === undefined
          ? ""
          : ` · ${t(gateway.offline ? "devices.gatewayOffline" : "devices.gatewayOnline")}`}
      </Text>
      <Text style={styles.muted}>
        {device.lastSeenMs === null
          ? t("devices.neverSeen")
          : t("devices.lastSeen", { time: formatTime(t, i18n.language, hub, device.lastSeenMs) })}
        {heardBy === undefined ? "" : ` · ${t("devices.heardBy", { gateway: heardBy })}`}
      </Text>
    </>
  );
}

function DeviceItem({
  device,
  gateway,
}: {
  readonly device: DeviceObject;
  readonly gateway: SnapshotObject["gateways"][number] | undefined;
}) {
  const { t } = useTranslation();
  return (
    <View role="listitem" style={styles.item} testID={`device-${String(device.id)}`}>
      <Heading level={3}>{device.name}</Heading>
      <DeviceItemFacts device={device} gateway={gateway} />
      <Link href={`/device/${String(device.id)}`} style={styles.navLink}>
        {t("devices.details", { name: device.name })}
      </Link>
    </View>
  );
}

export function DeviceList() {
  const { t } = useTranslation();
  const devices = useLive((s) => s.devices);
  const gateways = useLive((s) => s.gateways);
  const list = useMemo(
    () =>
      Object.values(devices).sort(
        (a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name),
      ),
    [devices],
  );
  return (
    <Section label={t("devices.listTitle")}>
      <Heading level={2}>{t("devices.listTitle")}</Heading>
      {list.length === 0 ? (
        <Body muted>{t("devices.none")}</Body>
      ) : (
        <View role="list">
          {list.map((device) => (
            <DeviceItem key={device.id} device={device} gateway={gateways[device.id]} />
          ))}
        </View>
      )}
    </Section>
  );
}

/** The notice that a device was added, gateways on their own (D100); a sensor starts disarmed (section 7). */
export function AddedNotices() {
  const { t } = useTranslation();
  const hub = useHub();
  const added = useLive((s) => s.added);
  const devices = useLive((s) => s.devices);
  if (added.length === 0) return null;
  return (
    <View style={{ gap: 8 }}>
      {added.map((id) => {
        const device = devices[id];
        if (device === undefined) return null;
        return (
          <Notice key={id} kind="ok" live="polite" testID={`added-${String(id)}`}>
            <Text style={styles.body}>{t(`added.${device.role}`, { name: device.name })}</Text>
            <View style={styles.row}>
              <Button
                kind="quiet"
                label={t("common.dismiss")}
                onPress={() => {
                  hub.live.setState(dismissAdded(hub.live.getState(), id), true);
                }}
              />
            </View>
          </Notice>
        );
      })}
    </View>
  );
}

type Port = AppOpReply<"usb.list">["ports"][number];

function UsbPort({ port }: { readonly port: Port }) {
  const { t } = useTranslation();
  const add = useAction("usb.add");
  const [name, setName] = useState("");
  const [role, setRole] = useState<DeviceObject["role"] | undefined>(
    port.identity?.role ?? undefined,
  );
  const [nameError, setNameError] = useState(false);
  const identity = port.identity;
  const submit = () => {
    const clean = name.trim();
    if (!deviceNameValue.safeParse(clean).success) {
      setNameError(true);
      return;
    }
    setNameError(false);
    void add.run({
      port: port.port,
      name: clean,
      ...(role === undefined || role === identity?.role ? {} : { role }),
    });
  };
  return (
    <View role="listitem" style={styles.item} testID={`usb-${port.port}`}>
      <Heading level={3}>{t("usb.port", { port: port.port })}</Heading>
      {identity === null ? (
        <Body muted>{t("usb.noIdentity")}</Body>
      ) : (
        <Text style={styles.body}>
          {[
            identity.role === null ? t("common.unknown") : t(`devices.role.${identity.role}`),
            t(`usb.paired.${identity.paired}`),
            t("devices.firmware", { version: identity.firmware }),
            t("usb.chip", { chip: identity.chipId }),
            ...(identity.development ? [t("usb.development")] : []),
          ].join(" · ")}
        </Text>
      )}
      <Choice
        label={t("usb.roleLabel", { port: port.port })}
        value={role}
        onChange={setRole}
        options={(["sensor", "siren", "gateway"] as const).map((r) => ({
          value: r,
          label: t(`devices.role.${r}`),
        }))}
      />
      <Field
        label={t("usb.nameLabel", { port: port.port })}
        hint={t("usb.nameHint")}
        value={name}
        onChange={setName}
        onSubmit={submit}
        autoComplete="off"
        testID={`usb-name-${port.port}`}
        {...(nameError ? { error: t("usb.nameError") } : {})}
      />
      <View style={styles.row}>
        <Button
          label={t("usb.add", { port: port.port })}
          busy={add.busy}
          onPress={submit}
          testID={`usb-add-${port.port}`}
        />
      </View>
      {add.outcome === undefined ? null : add.outcome.ok ? (
        <Notice kind="ok" live="polite">
          <Text style={styles.body}>{t("usb.added", { name: add.outcome.body.name })}</Text>
        </Notice>
      ) : (
        <Failure outcome={add.outcome} />
      )}
    </View>
  );
}

/**
 * Boards on this computer's USB ports, and adding one. Only the hub computer's browser may (C):
 * the screen asks the hub all the same and shows its answer, never deciding for it.
 */
export function UsbAdd() {
  const { t } = useTranslation();
  const hub = useHub();
  const connected = useLive((s) => s.connection.kind === "open");
  const [look, setLook] = useState(0);
  const ports = useQuery({
    queryKey: ["usb.list", look],
    queryFn: () => hub.request("usb.list", {}),
    enabled: connected,
  });
  return (
    <Section label={t("usb.title")}>
      <Heading level={2}>{t("usb.title")}</Heading>
      <Body>{t("usb.intro")}</Body>
      <View style={styles.row}>
        <Button
          kind="quiet"
          label={t("usb.look")}
          busy={ports.isFetching}
          onPress={() => {
            setLook((n) => n + 1);
          }}
          testID="usb-look"
        />
      </View>
      {ports.data === undefined ? null : !ports.data.ok ? (
        <Failure outcome={ports.data} />
      ) : ports.data.body.ports.length === 0 ? (
        <Body muted>{t("usb.none")}</Body>
      ) : (
        <View role="list">
          {ports.data.body.ports.map((port) => (
            <UsbPort key={port.port} port={port} />
          ))}
        </View>
      )}
    </Section>
  );
}
