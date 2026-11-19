/** The sensor update screens, from hub grant to the device's reported result. */
import type { AppEventBodyV2 } from "@hsn/protocol/app";
import { UPDATE_REASONS } from "@hsn/protocol/app";
import { secondsFromFifteenSecondUnits } from "@hsn/protocol/messages";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { bleCentral, type BleState } from "../platform/ble";
import { useLive, useRead } from "../ui/hub-context";
import { Actions, Body, Button, Notice, NoticeText, Page, Stack, TextLink } from "../ui/parts";
import { useFlowAwake } from "./awake";
import { downloadImage } from "./download";
import { phoneRequest, refusal, type PhoneHub } from "./hub";
import { BluetoothPermission } from "./permission";
import { isAborted, radioClock } from "./radio";
import { imageCache } from "./safe/cache";
import { updateGrant, updateSecondsLeft, updateTransfer } from "./update-flow";
import {
  type ActiveUpdate,
  afterFailedSend,
  backgroundEnds,
  mayResume,
  releaseUpdate,
  resultActions,
  type UpdateResultPage,
} from "./update-steps";

type UpdatePageName =
  "permission" | "asking" | "downloading" | "wake" | "finding" | "sending" | UpdateResultPage;
type UpdateNotice = AppEventBodyV2<"deviceUpdate">;

/** Displays the hub's final outcome and the sensor's own refusal in household terms. */
export function UpdateResult({
  event,
  version,
}: {
  readonly event: Pick<UpdateNotice, "state" | "reason">;
  readonly version: string;
}) {
  const { t } = useTranslation();
  const reason =
    event.state === "refused" || event.state === "rolledBack" ? event.reason : undefined;
  return (
    <Body testID="firmware-device-result">
      {t(`bluetoothUpdate.state.${event.state}`, { version })}
      {reason === undefined ? null : ` ${t(`bluetoothUpdate.reason.${reason}`)}`}
    </Body>
  );
}

/** Holds the grant and image in the screen's lifetime, disposing on exit, cancel or expiry. */
export function UpdatePage({ hub, device }: { readonly hub: PhoneHub; readonly device: number }) {
  const { t } = useTranslation();
  const [page, setPage] = useState<UpdatePageName>("permission");
  const [radio, setRadio] = useState<BleState>();
  const [error, setError] = useState("failed");
  const [downloaded, setDownloaded] = useState(0);
  const [served, setServed] = useState(0);
  const [left, setLeft] = useState<number>();
  const [latest, setLatest] = useState<UpdateNotice>();
  const [version, setVersion] = useState<string>();
  const reachedSensor = useRef(false);
  const resumeDeadline = useRef(0);
  const starting = useRef<AbortController | undefined>(undefined);
  const active = useRef<ActiveUpdate | undefined>(undefined);
  const watchedImage = useRef<number | undefined>(undefined);
  const firmware = useLive((s) => s.devices[device]?.firmware);
  const details = useRead("device.show", { device }, undefined);
  const settings = details.data?.ok ? details.data.body.settings : undefined;
  const heartbeatSeconds =
    settings !== undefined && "heartbeat" in settings
      ? secondsFromFifteenSecondUnits(settings.heartbeat)
      : 180;

  const inFront = ["wake", "finding", "sending", "resume"].includes(page);
  useFlowAwake(inFront);
  const back = <TextLink href={`/device/${device}`} label={t("bluetoothUpdate.back")} />;

  /** Zeros the memory-only key and deletes the cache on every terminal path. */
  const release = useCallback(() => {
    starting.current?.abort();
    starting.current = undefined;
    const running = active.current;
    active.current = undefined;
    if (running !== undefined) releaseUpdate(running);
  }, []);

  /** Ends the transfer and shows the exact reason in the UI. */
  const fail = useCallback(
    (reason: string) => {
      release();
      setError(reason);
      setPage("failure");
    },
    [release],
  );

  useEffect(() => release, [release]);
  useEffect(() => {
    return hub.onNewEvent((event) => {
      if (
        event.ev === "deviceUpdate" &&
        event.body.device === device &&
        (watchedImage.current === undefined || watchedImage.current === event.body.image)
      ) {
        setLatest(event.body);
        // A board can finish even if its Done notification is lost on the way back.
        if (
          watchedImage.current === event.body.image &&
          reachedSensor.current &&
          event.body.state === "confirmed"
        ) {
          release();
          setPage("sent");
        }
      }
    });
  }, [hub, device, release]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (
        state === "background" &&
        backgroundEnds(active.current !== undefined || starting.current !== undefined)
      )
        fail("interrupted");
      if (state === "active" && page === "permission" && radio === "unauthorized")
        void bleCentral.state().then((stateNow) => {
          if (stateNow === "on") void begin();
        });
    });
    return () => {
      listener.remove();
    };
  });
  useEffect(() => {
    if (page !== "resume") return;
    return radioClock.after(resumeDeadline.current - radioClock.now(), () => {
      fail("expired");
    });
  }, [page, fail]);

  /** Downloads the file while preserving already-verified repeated chunks on retry. */
  async function download() {
    const running = active.current;
    if (running === undefined) return;
    setPage("downloading");
    const result = await downloadImage(
      hub,
      running.offer,
      running.image,
      running.cache,
      radioClock,
      running.abort.signal,
      setDownloaded,
    );
    if (isAborted(running.abort.signal)) return;
    if (result.ok) setPage("wake");
    else if (result.fault === "corrupt") {
      running.cache.remove();
      const replacement = imageCache(running.offer.imageId);
      if (replacement === undefined) {
        fail("cache");
        return;
      }
      running.cache = replacement;
      setDownloaded(0);
      setPage("downloadFailed");
    } else setPage("downloadFailed");
    if (!result.ok) setError(result.fault);
  }

  /** Requests a grant and resolves its image id to the hub's numbered download reference. */
  async function begin() {
    if (starting.current !== undefined) return;
    const lifecycle = new AbortController();
    starting.current = lifecycle;
    setPage("asking");
    setLatest(undefined);
    watchedImage.current = undefined;
    setDownloaded(0);
    setServed(0);
    setLeft(undefined);
    const response = await phoneRequest(hub, "firmware.bluetooth", { device });
    if (isAborted(lifecycle.signal)) return;
    if (!response.ok) {
      fail(refusal(response));
      return;
    }
    const { imageId, fileBytes, sha256 } = response.value;
    const grant = updateGrant(response.value, radioClock);
    if (grant === undefined) {
      fail("protocol");
      return;
    }
    const cache = imageCache(imageId);
    if (cache === undefined) {
      grant.sessionKey.fill(0);
      fail("cache");
      return;
    }
    const running: ActiveUpdate = {
      offer: { imageId, fileBytes, sha256 },
      grant,
      cache,
      image: 0,
      abort: lifecycle,
      transfer: updateTransfer(bleCentral, radioClock, grant),
      stopExpiry: radioClock.after(grant.expiresAtMs - radioClock.now(), () => {
        fail("expired");
      }),
    };
    active.current = running;
    const list = await phoneRequest(hub, "firmware.list", {});
    if (isAborted(lifecycle.signal)) return;
    const image = list.ok
      ? list.value.images.find((stored) => stored.imageId === imageId)?.id
      : undefined;
    if (image === undefined) {
      fail(list.ok ? "noImage" : refusal(list));
      return;
    }
    active.current = { ...running, image };
    watchedImage.current = image;
    setVersion(grant.version);
    reachedSensor.current = false;
    await download();
  }

  /** Connects or carries on from the sensor's checkpoint while its deadline still holds. */
  async function send(resume: boolean) {
    const running = active.current;
    if (running === undefined) return;
    if (resume && !mayResume(radioClock.now(), resumeDeadline.current)) {
      fail("expired");
      return;
    }
    setPage("finding");
    setLeft(undefined);
    let first: { offset: number; at: number } | undefined;
    const result = await running.transfer.run(
      running.cache,
      running.abort.signal,
      !resume && running.grant.needsWake ? heartbeatSeconds * 1000 : 0,
      () => {
        reachedSensor.current = true;
        setPage("sending");
      },
      (highestOffset, connectionOffset) => {
        setServed(highestOffset);
        const current = { offset: connectionOffset, at: radioClock.now() };
        first ??= current;
        setLeft(updateSecondsLeft(running.grant.fileBytes, first, current));
      },
    );
    if (isAborted(running.abort.signal)) return;
    if (result.kind === "done") {
      if (!result.verified) {
        const reason = UPDATE_REASONS[result.reason - 1];
        fail(reason === undefined ? "protocol" : `reason.${reason}`);
        return;
      }
      release();
      setPage("sent");
      return;
    }
    const deadline = running.transfer.resumeUntil();
    if (
      afterFailedSend(result.fault, radioClock.now(), deadline, resume, reachedSensor.current) ===
      "resume"
    ) {
      resumeDeadline.current = deadline;
      setError(result.fault);
      setPage("resume");
      return;
    }
    fail(result.fault);
  }

  const cancel = (
    <Button
      kind="quiet"
      label={t("editing.cancel")}
      onPress={() => {
        release();
        setPage("cancelled");
      }}
    />
  );
  const running = active.current;
  const total = running?.offer.fileBytes ?? 1;
  const moveNear = t("bluetoothUpdate.near");
  const notice = (text: string) => (
    <Notice kind="warning" live="polite">
      <NoticeText kind="warning">{text}</NoticeText>
    </Notice>
  );

  if (page === "permission")
    return (
      <BluetoothPermission
        state={radio}
        onAnswer={(answer) => {
          setRadio(answer);
          if (answer === "on") void begin();
        }}
        exit={back}
      />
    );
  if (page === "wake")
    return (
      <Page
        title={t("bluetoothUpdate.wakeTitle")}
        intro={
          running?.grant.needsWake === true
            ? t("bluetoothUpdate.wake", {
                duration:
                  heartbeatSeconds % 60 === 0
                    ? t("bluetoothUpdate.minutes", { count: heartbeatSeconds / 60 })
                    : t("bluetoothUpdate.seconds", { count: heartbeatSeconds }),
              })
            : moveNear
        }
      >
        <Stack>
          <Actions>
            <Button label={t("bluetoothUpdate.findAction")} onPress={() => void send(false)} />
            {cancel}
          </Actions>
        </Stack>
      </Page>
    );

  const result = page === "failure" && latest?.state === "confirmed" ? "sent" : page;
  /** Renders the ordered actions shared by the result pages. */
  const controlsFor = (outcome: UpdateResultPage) => {
    const controls = {
      back,
      cancel,
      resume: <Button label={t("bluetoothUpdate.resume")} onPress={() => void send(true)} />,
      downloadAgain: (
        <Button label={t("bluetoothUpdate.downloadAgain")} onPress={() => void download()} />
      ),
      startAgain: (
        <Button
          label={t("bluetoothUpdate.startAgain")}
          onPress={() => {
            setRadio(undefined);
            setPage("permission");
          }}
        />
      ),
    };
    return resultActions(outcome).map((action) => (
      <Fragment key={action}>{controls[action]}</Fragment>
    ));
  };
  if (result === "sent") {
    const finished =
      latest?.state === "confirmed" ||
      latest?.state === "rolledBack" ||
      latest?.state === "refused";
    return (
      <Page
        title={t("bluetoothUpdate.sent")}
        {...(finished ? {} : { intro: t("bluetoothUpdate.installLater") })}
      >
        <Stack>
          {latest === undefined ? null : (
            <UpdateResult event={latest} version={version ?? firmware ?? ""} />
          )}
          {controlsFor(result)}
        </Stack>
      </Page>
    );
  }
  if (result === "cancelled")
    return (
      <Page title={t("bluetoothUpdate.cancelled")} intro={t("bluetoothUpdate.cancelledHint")}>
        <Stack>
          <Actions>{controlsFor(result)}</Actions>
        </Stack>
      </Page>
    );
  if (result === "resume")
    return (
      <Page title={t("bluetoothUpdate.resumeTitle")} intro={t("bluetoothUpdate.resumeHint")}>
        <Actions>{controlsFor(result)}</Actions>
      </Page>
    );

  if (result === "failure" || result === "downloadFailed") {
    const key = error.startsWith("reason.")
      ? `bluetoothUpdate.${error}`
      : `bluetoothUpdate.failure.${error}`;
    return (
      <Page title={t("bluetoothUpdate.problem")}>
        <Stack>
          {notice(t(key, { defaultValue: t("bluetoothUpdate.failure.failed") }))}
          <Actions>{controlsFor(result)}</Actions>
        </Stack>
      </Page>
    );
  }

  const title =
    page === "asking"
      ? "asking"
      : page === "downloading"
        ? "downloading"
        : page === "finding"
          ? "finding"
          : "sending";
  const percent = Math.min(
    100,
    Math.floor(((title === "sending" ? served : downloaded) * 100) / total),
  );
  return (
    <Page
      title={t(`bluetoothUpdate.${title}`)}
      {...(title === "finding" || title === "sending" ? { intro: moveNear } : {})}
    >
      <Stack>
        {title === "sending" || title === "downloading" ? (
          <Body testID="firmware-progress">
            {t(
              title === "sending" && left !== undefined
                ? "bluetoothUpdate.progressTime"
                : "bluetoothUpdate.progress",
              { percent, count: left ?? 0 },
            )}
          </Body>
        ) : null}
        <Actions>{cancel}</Actions>
      </Stack>
    </Page>
  );
}
