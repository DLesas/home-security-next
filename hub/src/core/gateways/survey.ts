/**
 * The site's radio as the gateways listen to it (hub-design.md section 8, "Site channel and data
 * rate"): the channel survey of `hsn site survey`, and `hsn site set channel=… rate=…` reaching
 * the gateways.
 *
 * - **Survey.** No message asks a gateway to measure another channel, so the hub surveys by
 *   settings: for each channel in turn every connected gateway is sent settings with it, the
 *   first gateway's first status on them is discarded (it may cover the old channel), and the
 *   median noise of the next four is averaged (2 minutes ‡). The lowest average wins; on a tie the
 *   lowest highest reading, then 868.3 MHz. The answer names the channel, and the site module
 *   takes it from the answer into its row; the gateways are left on it.
 * - **Site set.** The site module answers `hsn site set`; a change of channel or rate it made
 *   reaches the gateways from that answer, with new settings to every one.
 *
 * Only before a sensor or siren is paired (section 8): a channel cannot change after that but by
 * a site move (D115).
 */
import { SiteChannel } from "@hsn/protocol";
import { err } from "neverthrow";
import type { CommandResult } from "../model/control.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import type { DomainMessage } from "../model/messages.ts";
import { answerError, answerOk } from "../control/view.ts";
import { isNamed, registeredDevices } from "../registry/view.ts";
import { done, type Outcome, then, withGateway } from "./common.ts";
import { sendSettings } from "./sessions.ts";
import { configWrite, nextSettingsVersion, rateMask } from "./settings.ts";
import type { GatewaysSlice, SiteRadio, Survey } from "./state.ts";

type SurveyRequest = Extract<DomainMessage, { readonly kind: "siteSurveyRequest" }>;
type SiteSetResult = Extract<CommandResult, { readonly kind: "siteSet" }>;

/** The site channels in survey order: 868.1, 868.3, 868.5 MHz (§6). */
const CHANNELS: readonly number[] = [
  SiteChannel.Mhz868_1,
  SiteChannel.Mhz868_3,
  SiteChannel.Mhz868_5,
];
/** On a tie of both figures, the survey takes 868.3 MHz (section 8). */
const TIE_CHANNEL = SiteChannel.Mhz868_3;

/**
 * Every gateway gets the site's radio as `site` now gives it: a new settings version, written
 * now, and sent at once on a live session (section 8, "Gateway sessions": on every change).
 */
export function resettle(slice: GatewaysSlice, site: SiteRadio, ctx: Context): Outcome {
  const devices = [...slice.gateways.keys()].toSorted((a, b) => a - b);
  return devices.reduce<Outcome>(
    (result, device) =>
      then(result, (s) => {
        const entry = s.gateways.get(device);
        if (entry === undefined) return done(s);
        const config = { ...entry.config, version: nextSettingsVersion(entry.config.version) };
        const bumped = { ...entry, config };
        const written = done(withGateway(s, bumped), [configWrite(device, config)]);
        const session = bumped.live;
        return session === undefined
          ? written
          : then(written, (w) => sendSettings(w, bumped, session, ctx));
      }),
    done({ ...slice, site }),
  );
}

function anyPaired(ctx: Context): boolean {
  return registeredDevices(ctx.view).some(
    (row) => (row.role === 1 || row.role === 2) && isNamed(row.state),
  );
}

/** `hsn site survey` (section 8). */
export function startSurvey(slice: GatewaysSlice, request: SurveyRequest, ctx: Context): Outcome {
  const refuse = (code: Parameters<typeof answerError>[1], message: string) =>
    done(slice, [answerError(request.request, code, message)]);
  if (slice.survey !== undefined) return refuse("failed", "a survey is already running");
  if (anyPaired(ctx)) {
    return refuse(
      "sitePaired",
      "the channel is fixed once a sensor or siren is paired: use `hsn site change`",
    );
  }
  const first = [...slice.gateways.values()]
    .filter((entry) => entry.live !== undefined)
    .toSorted((a, b) => a.device - b.device)[0];
  if (first === undefined) return refuse("noGateway", "a survey needs a connected gateway");
  const survey: Survey = {
    request: request.request,
    gateway: first.device,
    index: 0,
    discarded: 0,
    medians: [],
    highest: [],
    results: [],
  };
  return retune({ ...slice, survey }, ctx);
}

/** Every gateway onto the channel the survey measures now. */
function retune(slice: GatewaysSlice, ctx: Context): Outcome {
  const channel = slice.survey === undefined ? slice.site.channel : CHANNELS[slice.survey.index];
  return resettle(slice, { ...slice.site, channel: channel ?? slice.site.channel }, ctx);
}

/** The average of some numbers. */
function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

/** A status of the surveyed gateway on its current settings: discarded, counted, or the last. */
export function surveyStatus(
  slice: GatewaysSlice,
  gateway: DeviceId,
  status: {
    readonly settingsVersion: number;
    readonly noiseMedianDbm: number;
    readonly noiseHighestDbm: number;
  },
  ctx: Context,
): Outcome {
  const survey = slice.survey;
  const entry = slice.gateways.get(gateway);
  if (survey?.gateway !== gateway || entry === undefined) return done(slice);
  // A status on the settings before this channel's covers the old channel.
  if (status.settingsVersion !== entry.config.version) return done(slice);
  const { surveyDiscardStatuses, surveyStatuses } = ctx.deps.rules.noise;
  if (survey.discarded < surveyDiscardStatuses) {
    return done({ ...slice, survey: { ...survey, discarded: survey.discarded + 1 } });
  }
  const medians = [...survey.medians, status.noiseMedianDbm];
  const highest = [...survey.highest, status.noiseHighestDbm];
  if (medians.length < surveyStatuses) {
    return done({ ...slice, survey: { ...survey, medians, highest } });
  }
  const results = [
    ...survey.results,
    {
      channel: CHANNELS[survey.index] ?? TIE_CHANNEL,
      medianDbm: mean(medians),
      highestDbm: Math.max(...highest),
    },
  ];
  if (survey.index + 1 < CHANNELS.length) {
    const next: Survey = {
      ...survey,
      index: survey.index + 1,
      discarded: 0,
      medians: [],
      highest: [],
      results,
    };
    return retune({ ...slice, survey: next }, ctx);
  }
  const chosen = results.toSorted(
    (a, b) =>
      a.medianDbm - b.medianDbm ||
      a.highestDbm - b.highestDbm ||
      Number(b.channel === TIE_CHANNEL) - Number(a.channel === TIE_CHANNEL),
  )[0];
  const channel = chosen?.channel ?? TIE_CHANNEL;
  return then(resettle({ ...slice, survey: undefined }, { ...slice.site, channel }, ctx), (s) =>
    done(s, [
      answerOk(survey.request, {
        kind: "siteSurvey",
        channel,
        noise: results.map((r) => ({ channel: r.channel, medianDbm: r.medianDbm })),
      }),
    ]),
  );
}

/**
 * `hsn site set` answered: a channel or rate the site module changed reaches every gateway. A
 * survey's own answer comes back here too, and changes nothing more.
 */
export function siteSet(slice: GatewaysSlice, result: SiteSetResult, ctx: Context): Outcome {
  if (slice.survey !== undefined) return done(slice);
  const channel = result.site.channel ?? slice.site.channel;
  const mask = rateMask(ctx, result.site.rate);
  if (mask.isErr()) return err(mask.error);
  if (channel === slice.site.channel && mask.value === slice.site.rateMask) return done(slice);
  return resettle(slice, { ...slice.site, channel, rateMask: mask.value }, ctx);
}
