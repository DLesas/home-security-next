/**
 * Every value the hub's rules use (hub-design.md section 8, its table and its prose), in one
 * object, so a scenario test or the bench can change one without touching code (section 2).
 * Each value names its source: † the protocol's provisional values, ‡ this design's own, each
 * to be set by a measurement. Durations are milliseconds unless the name says otherwise.
 */
import { EVENT_LISTEN_MS } from "@hsn/protocol";
import type { CadenceMs } from "./effects.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

/**
 * The size guard (section 6): the data folder held under 500 MB by size as well as by age. Every
 * mark, count and age is a parameter, so a test runs the whole rule on a few megabytes.
 */
export interface SizeGuardRules {
  /** `max_page_count` in bytes: SQLite refuses to grow the file past it (240 MB ‡). */
  readonly hardStopBytes: number;
  /** Trimming starts when the pages in use pass this (225 MB ‡) ... */
  readonly startBytes: number;
  /** ... and goes on until they are back under this (210 MB ‡). */
  readonly stopBytes: number;
  /** Rows deleted from each table a trimming commit (5,000 ‡). */
  readonly rowsPerCommit: number;
  /** Routine rows younger than this are never trimmed (24 h ‡). */
  readonly routineProtectedMs: number;
  /** Event rows younger than this are never trimmed (30 days ‡). */
  readonly eventProtectedMs: number;
  /** `fatal.log` is cut back to its newest half when it passes this (1 MB ‡). */
  readonly fatalLogMaxBytes: number;
}

export interface HubRules {
  /** When to reply (section 8, "When to reply"; §6, §7, D72). */
  readonly replies: {
    /** End of the heartbeat to start of its reply: 1 s † (§8). */
    readonly heartbeatReplyMomentMs: number;
    /** How long a sensor listens after an event report, DR0 to DR5: 3.0 to 1.5 s † (§8). */
    readonly eventListenMs: readonly number[];
    /** A heartbeat reply decided later than this after the heartbeat's end is skipped: 700 ms ‡. */
    readonly heartbeatTooLateMs: number;
    /** An event reply through another gateway starts this much before its latest moment: 20 ms ‡. */
    readonly otherGatewayMarginMs: number;
    /** The disarmed notice is sent this many times (§8, D24). */
    readonly disarmedNoticeCopies: number;
    /** ... this far apart (§8, D24). */
    readonly disarmedNoticeGapMs: number;
  };
  /** Siren commands and paths (section 8; §7, §8, D52, D73, D80). */
  readonly sirens: {
    /** Repeats until confirmed: every 2 s on Wi-Fi (§8). */
    readonly wifiRepeatMs: number;
    /** ... every 5 s on LoRa (§8). */
    readonly loraRepeatMs: number;
    /** ... for up to a minute, then `siren_unreachable` (§8). */
    readonly giveUpMs: number;
    /** "Report now" to each siren within 120 s ‡ of a start, as each path appears (D80). */
    readonly reportNowWithinMs: number;
    /** A siren that should sound is commanded again only with at least 10 s ‡ left. */
    readonly correctionMinLeftMs: number;
    /** The best gateway is the one that heard the siren best in the last 15 minutes ‡. */
    readonly bestGatewayWindowMs: number;
    /** Commands on Wi-Fi go to every socket with an accepted packet in the last 60 s ‡. */
    readonly wifiSocketWindowMs: number;
    /** Wi-Fi path lost: 2 × the report interval + 10 s, 70 s ‡ (D73). */
    readonly wifiPathLostMs: number;
    /** LoRa path lost while Wi-Fi works: 2 × the check interval + 30 s, 630 s ‡ (D73). */
    readonly loraPathLostMs: number;
    /** On LoRa alone a siren paces reports to P = max(report interval, 200 × airtime) (§7). */
    readonly loraOnlyPaceAirtimes: number;
    /** ... the airtime of a report this long, in bytes (§2). */
    readonly loraOnlyReportBytes: number;
    /** Silent on LoRa alone after 2P + max(10 s ‡, P ÷ 10 ‡) (§7, D52): the 10 s. */
    readonly loraOnlySilenceMinExtraMs: number;
    /** ... the ÷ 10. */
    readonly loraOnlySilenceExtraFraction: number;
  };
  /** Heartbeat slots (section 8; §7, D108). */
  readonly slots: {
    /** Each slot's guard for clock wander: 2 s ‡. */
    readonly guardMs: number;
    /** All phases are planned again when the smallest clearance falls below this many spans ‡. */
    readonly replanBelowSpans: number;
    /** A new phase takes the largest clearance over this horizon: an hour. */
    readonly clearanceHorizonMs: number;
    /** The early heartbeat after Started comes at least 30 s ‡ after it. */
    readonly earlyHeartbeatAfterStartedMs: number;
    /** A session's clock offset is the smallest of the last 64 frames. */
    readonly clockMappingFrames: number;
    /** The next heartbeat is the first slot at least half an interval after the answered one. */
    readonly minIntervalFractionAhead: number;
  };
  /** Clock correction (section 8; §7, D108, S8). */
  readonly clockCorrection: {
    /** The estimate is the median of the last 5 ‡ samples. */
    readonly medianOf: number;
    /** A correction is sent only with at least 3 samples. */
    readonly minSamples: number;
    /** A sample more than 0.5 s ‡ off the estimate's prediction is dropped. */
    readonly outlierMs: number;
    /** Samples span at most 4 intervals. */
    readonly maxIntervals: number;
    /** A new correction is sent when it differs by at least 50 ppm ‡. */
    readonly changePpm: number;
    /** ... at most once every 6 hours ‡. */
    readonly minIntervalMs: number;
    /** Limited to ±32 % (§6). */
    readonly limitPpm: number;
  };
  /** The reply rate (section 8; §7 "Faster replies", D108). */
  readonly replyRate: {
    /** From the SNR of the last 20 accepted packets at the best gateway. */
    readonly snrSamples: number;
    /** ... their 10th percentile. */
    readonly snrPercentile: number;
    /** With fewer than 10 samples, the sending rate. */
    readonly minSamples: number;
    /** The sensor's transmit power (§2). */
    readonly sensorPowerDbm: number;
    /** Demodulation limit at SF7, dB (the bench's `lora_physics.cpp`). */
    readonly demodLimitSf7Db: number;
    /** ... falling by this many dB per spreading factor above 7. */
    readonly demodLimitPerSfDb: number;
    /** At most 3 steps faster than the sending rate (§8). */
    readonly maxStepsFaster: number;
    /** The limit must be at least 10 dB ‡ below the downlink estimate (§14). */
    readonly marginDb: number;
    /** Faster only with 3 dB ‡ to spare. */
    readonly hysteresisDb: number;
    /** Faster at most once every 6 hours ‡. */
    readonly minIntervalMs: number;
    /** Flag bit 7: this many steps slower at once ‡. */
    readonly stepsSlowerOnFallback: number;
  };
  /** Silence (section 8; D52, D73, D97, D107, HB25). */
  readonly silence: {
    /** A sensor is silent after n × I + 30 s ‡, n from 3 ... */
    readonly sensorMinMissed: number;
    /** ... to 8 ... */
    readonly sensorMaxMissed: number;
    /** ... and 5 ‡ before it has a day of loss data (D114). */
    readonly sensorDefaultMissed: number;
    /** The 30 s ‡. */
    readonly sensorExtraMs: number;
    /** n is chosen from the last 7 days. */
    readonly lossDays: number;
    /** Fewer than this many false silence alerts a year on the site. */
    readonly falseAlertsPerYear: number;
    /** A loss above 20 % is a poor link (D107). */
    readonly poorLinkLoss: number;
    /** A gateway is offline after 60 s with nothing (§7, D97). */
    readonly gatewayOfflineMs: number;
    /** An offline gateway names the sensors no other gateway heard in the last hour (D97). */
    readonly heardByOtherGatewayMs: number;
  };
  /** The site move (section 8, "Changing the site's channel or rate"; §7, D115). */
  readonly siteMove: {
    /** A sensor not yet heard on the new settings has its silence held back this many intervals †. */
    readonly silenceGraceIntervals: number;
    /** A sensor that has not confirmed after this many of its intervals † raises `move_stalled`. */
    readonly stallIntervals: number;
    /** Siren settings are repeated this often after the first minute, until confirmed ‡. */
    readonly sirenSettingsRepeatMs: number;
  };
  /** The gateway's noise against its long-term level (section 8; D82, §14). */
  readonly noise: {
    /** The baseline's time constant: 24 hours ‡. */
    readonly baselineTimeConstantMs: number;
    /** A status updates the baseline only when at most 3 dB ‡ above it. */
    readonly learnMaxAboveDb: number;
    /** A new gateway's baseline starts after its first hour ... */
    readonly firstPeriodMs: number;
    /** ... as the 20th percentile of the medians. */
    readonly firstPeriodPercentile: number;
    /** Interference: the median at least 10 dB † above the baseline ... */
    readonly alertDb: number;
    /** ... in 2 ‡ consecutive statuses. */
    readonly alertStatuses: number;
    /** It ends after as many statuses 3 dB below the alert level. */
    readonly endBelowAlertDb: number;
    /** Damaged packets: more than half failing the CRC ... */
    readonly damagedFraction: number;
    /** ... over 2 statuses ... */
    readonly damagedStatuses: number;
    /** ... with at least 10 ‡ packets. */
    readonly damagedMinPackets: number;
    /** The channel survey discards the first status on each channel ... */
    readonly surveyDiscardStatuses: number;
    /** ... and averages the medians of the next four (2 minutes ‡). */
    readonly surveyStatuses: number;
  };
  /** Gateways and transmit requests (sections 7 and 8). */
  readonly gateways: {
    /** A second session unproven after the status interval and 10 s ‡ more is closed. */
    readonly unprovenSessionMs: number;
    /** No transmit result by the latest moment + 5 s ‡ is "no result" ... */
    readonly resultGraceMs: number;
    /** ... or 10 s ‡ after the request with no limit. */
    readonly resultNoLimitMs: number;
  };
  /** Durability and commits (section 5; D112, D113, HB35). */
  readonly persistence: {
    /** Routine items wait at most five minutes. */
    readonly routineBatchMs: CadenceMs;
    /** While a countdown or the alarm runs, a commit every second. */
    readonly runningCadenceMs: CadenceMs;
    /** Warnings and worse are written now, at most 60 ‡ an hour per source. */
    readonly warningsPerHourPerSource: number;
    /** A flush when 2,000 ‡ items are staged ... */
    readonly flushItems: number;
    /** ... or 512 KB ‡. */
    readonly flushBytes: number;
    /** The size guard (section 6, "The size guard"; D112's ceiling). */
    readonly sizeGuard: SizeGuardRules;
  };
  /** Arming and the countdown (section 8; D40, D50, D67, D86, D106, D114). */
  readonly arming: {
    /** A door opened more than 2 s ‡ before arming counts as open at arming (D114). */
    readonly openedBeforeArmingToleranceMs: number;
    /** The entry countdown's default (D40). */
    readonly countdownDefaultS: number;
    /** The sirens' automatic stop (D40). */
    readonly autoStopS: number;
  };
  /** Transmit powers in gateway settings (section 8; §2, D108). */
  readonly powers: {
    /** Replies and notices: 22 dBm ‡. */
    readonly defaultTxPowerDbm: number;
    /** Siren commands: 22 dBm ‡. */
    readonly sirenTxPowerDbm: number;
  };
  /** The site (section 8, "Site channel and data rate"). */
  readonly site: {
    /** One sending rate per site, DR5 by default ‡. */
    readonly defaultRate: number;
  };
  /** Accepting packets (section 8). */
  readonly intake: {
    /** A log entry repeats an earlier one made within 15 s ‡. */
    readonly logRepeatWithinMs: number;
  };
  /** USB setup (section 9). */
  readonly setup: {
    /** A Provision with no answer in 5 s ‡ leaves the device provisioning. */
    readonly provisionAnswerMs: number;
  };
  /** Retention (section 6). */
  readonly retention: {
    /** A round every 10 minutes ‡ ... */
    readonly everyMs: number;
    /** ... deleting up to 2,000 ‡ rows a table. */
    readonly rowsPerRound: number;
  };
}

/** The rules as the design sets them. */
export const DEFAULT_RULES: HubRules = {
  replies: {
    heartbeatReplyMomentMs: SECOND,
    eventListenMs: EVENT_LISTEN_MS,
    heartbeatTooLateMs: 700,
    otherGatewayMarginMs: 20,
    disarmedNoticeCopies: 2,
    disarmedNoticeGapMs: 2 * SECOND,
  },
  sirens: {
    wifiRepeatMs: 2 * SECOND,
    loraRepeatMs: 5 * SECOND,
    giveUpMs: MINUTE,
    reportNowWithinMs: 120 * SECOND,
    correctionMinLeftMs: 10 * SECOND,
    bestGatewayWindowMs: 15 * MINUTE,
    wifiSocketWindowMs: 60 * SECOND,
    wifiPathLostMs: 70 * SECOND,
    loraPathLostMs: 630 * SECOND,
    loraOnlyPaceAirtimes: 200,
    loraOnlyReportBytes: 28,
    loraOnlySilenceMinExtraMs: 10 * SECOND,
    loraOnlySilenceExtraFraction: 0.1,
  },
  slots: {
    guardMs: 2 * SECOND,
    replanBelowSpans: 2,
    clearanceHorizonMs: HOUR,
    earlyHeartbeatAfterStartedMs: 30 * SECOND,
    clockMappingFrames: 64,
    minIntervalFractionAhead: 0.5,
  },
  clockCorrection: {
    medianOf: 5,
    minSamples: 3,
    outlierMs: 500,
    maxIntervals: 4,
    changePpm: 50,
    minIntervalMs: 6 * HOUR,
    limitPpm: 320_000,
  },
  replyRate: {
    snrSamples: 20,
    snrPercentile: 10,
    minSamples: 10,
    sensorPowerDbm: 14,
    demodLimitSf7Db: -7.5,
    demodLimitPerSfDb: -2.5,
    maxStepsFaster: 3,
    marginDb: 10,
    hysteresisDb: 3,
    minIntervalMs: 6 * HOUR,
    stepsSlowerOnFallback: 1,
  },
  silence: {
    sensorMinMissed: 3,
    sensorMaxMissed: 8,
    sensorDefaultMissed: 5,
    sensorExtraMs: 30 * SECOND,
    lossDays: 7,
    falseAlertsPerYear: 1,
    poorLinkLoss: 0.2,
    gatewayOfflineMs: 60 * SECOND,
    heardByOtherGatewayMs: HOUR,
  },
  siteMove: { silenceGraceIntervals: 4, stallIntervals: 4, sirenSettingsRepeatMs: MINUTE },
  noise: {
    baselineTimeConstantMs: 24 * HOUR,
    learnMaxAboveDb: 3,
    firstPeriodMs: HOUR,
    firstPeriodPercentile: 20,
    alertDb: 10,
    alertStatuses: 2,
    endBelowAlertDb: 3,
    damagedFraction: 0.5,
    damagedStatuses: 2,
    damagedMinPackets: 10,
    surveyDiscardStatuses: 1,
    surveyStatuses: 4,
  },
  gateways: {
    unprovenSessionMs: 10 * SECOND,
    resultGraceMs: 5 * SECOND,
    resultNoLimitMs: 10 * SECOND,
  },
  persistence: {
    routineBatchMs: 300_000,
    runningCadenceMs: 1_000,
    warningsPerHourPerSource: 60,
    flushItems: 2000,
    flushBytes: 512 * 1024,
    sizeGuard: {
      hardStopBytes: 240 * MB,
      startBytes: 225 * MB,
      stopBytes: 210 * MB,
      rowsPerCommit: 5_000,
      routineProtectedMs: 24 * HOUR,
      eventProtectedMs: 30 * DAY,
      fatalLogMaxBytes: 1 * MB,
    },
  },
  arming: {
    openedBeforeArmingToleranceMs: 2 * SECOND,
    countdownDefaultS: 30,
    autoStopS: 300,
  },
  powers: { defaultTxPowerDbm: 22, sirenTxPowerDbm: 22 },
  site: { defaultRate: 5 },
  intake: { logRepeatWithinMs: 15 * SECOND },
  setup: { provisionAnswerMs: 5 * SECOND },
  retention: { everyMs: 10 * MINUTE, rowsPerRound: 2000 },
};
