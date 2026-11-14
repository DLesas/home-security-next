/**
 * The gateways module's handler (hub-design.md section 2, module 6; sections 7 and 8): sessions
 * and takeover, settings, forwarded packets and the clock mapping, transmit requests and their
 * results, statuses and the noise rules, gateway silence, and which gateways heard which
 * devices. Each message kind goes to its part:
 *
 * - `boot`, `deviceAdded`, `deviceRemoved`, `siteMove`, `commit`: `lifecycle.ts`;
 * - `gatewayPacket`: `packets.ts` (and `sessions.ts` for hellos and proofs);
 * - `radioOut`, `sendFailed` and the `transmitResult` timer: `transmit.ts`;
 * - `linkClosed` and the `unprovenSession` timer: `sessions.ts`;
 * - the `offline` timer: `lifecycle.ts`;
 * - `accepted` and `rejected` (duplicates): `hearing.ts`.
 */
import type { Handler } from "../model/handler.ts";
import { done } from "./common.ts";
import { onAccepted, onDuplicate } from "./hearing.ts";
import {
  handleAdded,
  handleBoot,
  handleCommitFailed,
  handleOffline,
  handleRemoved,
  handleSiteMove,
} from "./lifecycle.ts";
import { handleGatewayPacket } from "./packets.ts";
import { handleLinkClosed, handleUnproven } from "./sessions.ts";
import { handleRadioOut, handleSendFailed, handleTransmitTimeout } from "./transmit.ts";

/** The handler of module 6 (section 2). */
import { setGateway, siteSet, startSurvey } from "./survey.ts";

export const handleGateways: Handler<"gateways"> = (slice, message, ctx) => {
  switch (message.kind) {
    case "boot":
      return handleBoot(slice, message.snapshot, message.boot.id, ctx);
    case "deviceAdded":
      return handleAdded(slice, message, ctx);
    case "deviceRemoved":
      return handleRemoved(slice, message.device);
    case "siteMove":
      return handleSiteMove(slice, message, ctx);
    case "siteSurveyRequest":
      return startSurvey(slice, message, ctx);
    case "gatewaySettingsRequest":
      return setGateway(slice, message, ctx);
    case "answer":
      return message.reply.ok && message.reply.result.kind === "siteSet"
        ? siteSet(slice, message.reply.result, ctx)
        : done(slice);
    case "commit":
      return message.outcome.kind === "failed" ? handleCommitFailed(slice) : done(slice);
    case "gatewayPacket":
      return handleGatewayPacket(slice, message.link, message.bytes, ctx);
    case "radioOut":
      return handleRadioOut(slice, message, ctx);
    case "sendFailed":
      return handleSendFailed(slice, message.link, message.ref, message.error);
    case "linkClosed":
      return handleLinkClosed(slice, message.link);
    case "accepted":
      return done(onAccepted(slice, message, ctx.now.mono, ctx.deps.rules));
    case "rejected":
      return done(onDuplicate(slice, message, ctx.view, ctx.now.mono, ctx.deps.rules));
    case "timer":
      if (message.key.module !== "gateways") return done(slice);
      switch (message.key.kind) {
        case "offline":
          return handleOffline(slice, message.key.gateway, ctx);
        case "unprovenSession":
          return handleUnproven(slice, message.key.link, ctx);
        case "transmitResult":
          return handleTransmitTimeout(slice, message.key);
      }
      return done(slice);
    default:
      return done(slice);
  }
};
