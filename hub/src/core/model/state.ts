/**
 * The core's whole state (hub-design.md section 2, "State"; m2-design.md section 2): one slice per
 * module, in the dispatcher's order. Each slice's
 * type is declared in its module's `state.ts`, where its owner fills it in; every slice is a
 * tree of `readonly` interfaces, `ReadonlyMap` and `ReadonlyArray`, and holds its own timers
 * and sending counters.
 */
import type { AlarmSlice } from "../alarm/state.ts";
import type { PeopleSlice } from "../people/state.ts";
import type { LayoutSlice } from "../layout/state.ts";
import type { AppSlice } from "../app/state.ts";
import type { SchedulesSlice } from "../schedules/state.ts";
import type { HealthSlice } from "../health/state.ts";
import type { NotifySlice } from "../notify/state.ts";
import type { UpkeepSlice } from "../upkeep/state.ts";
import type { AuditSlice } from "../audit/state.ts";
import type { ClockSlice } from "../clock/state.ts";
import type { ControlSlice } from "../control/state.ts";
import type { GatewaysSlice } from "../gateways/state.ts";
import type { IntakeSlice } from "../intake/state.ts";
import type { LinksSlice } from "../links/state.ts";
import type { RegistrySlice } from "../registry/state.ts";
import type { SensorsSlice } from "../sensors/state.ts";
import type { SetupSlice } from "../setup/state.ts";
import type { SiteSlice } from "../site/state.ts";
import type { SirensSlice } from "../sirens/state.ts";
import type { SlotsSlice } from "../slots/state.ts";

export interface HubState {
  /** Boot, last now seen, wall trust, downtime estimate. */
  readonly clock: ClockSlice;
  /** Devices, addresses, names, roles, pairing state. */
  readonly registry: RegistrySlice;
  /** Which link carries what. */
  readonly links: LinksSlice;
  /** USB setup exchanges in progress. */
  readonly setup: SetupSlice;
  /** Commands waiting for an answer. */
  readonly control: ControlSlice;
  /** People, clients and their keys, permissions, link tokens, last `seq` (M2). */
  readonly people: PeopleSlice;
  /** Groups, modes and the current mode (M2). */
  readonly layout: LayoutSlice;
  /** App sessions and the live revision (M2; memory only). */
  readonly app: AppSlice;
  /** Schedule entries and their next times, the hub's time zone (M2). */
  readonly schedules: SchedulesSlice;
  /** Sessions, settings, clock mapping, transmit requests, noise. */
  readonly gateways: GatewaysSlice;
  /** Replay windows, duplicate copies, rejection counts. */
  readonly intake: IntakeSlice;
  /** Armed state per sensor, countdowns, the alarm. */
  readonly alarm: AlarmSlice;
  /** The site's channel and rate, and a move between them (D115). */
  readonly site: SiteSlice;
  /** Settings and versions, reply rates, silence. */
  readonly sensors: SensorsSlice;
  /** Heartbeat slots, clock correction estimates. */
  readonly slots: SlotsSlice;
  /** Settings, what each should do and does, commands in flight, paths. */
  readonly sirens: SirensSlice;
  /** Battery and tamper state (M2). */
  readonly health: HealthSlice;
  /** Notifications, recipients, categories and reads (M2). */
  readonly notify: NotifySlice;
  /** Backups, the backup key, a restore under way, updates (M2). */
  readonly upkeep: UpkeepSlice;
  /** Record sequence, rejection minute counts, retention timers. */
  readonly audit: AuditSlice;
}
