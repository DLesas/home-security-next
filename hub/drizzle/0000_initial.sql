CREATE TABLE `alarm` (
	`boot` integer NOT NULL,
	`started_mono` integer NOT NULL,
	`cause_seq` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alarm_sirens` (
	`siren_id` integer PRIMARY KEY NOT NULL,
	`boot` integer NOT NULL,
	`until_mono` integer NOT NULL,
	`commanded` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alarm_triggers` (
	`sensor_id` integer PRIMARY KEY NOT NULL,
	`kind` integer NOT NULL,
	`boot` integer NOT NULL,
	`at_mono` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `boots` (
	`id` integer PRIMARY KEY NOT NULL,
	`started_ms` integer NOT NULL,
	`started_trusted` integer NOT NULL,
	`previous_exit` text NOT NULL,
	`cause` text,
	`clean_stop_ms` integer,
	`trusted_at_mono` integer,
	`clock_step_ms` integer
);
--> statement-breakpoint
CREATE TABLE `commands` (
	`seq` integer PRIMARY KEY NOT NULL,
	`at_ms` integer NOT NULL,
	`clock_ok` integer NOT NULL,
	`actor` text NOT NULL,
	`kind` text NOT NULL,
	`args` text NOT NULL,
	`outcome` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `countdowns` (
	`sensor_id` integer PRIMARY KEY NOT NULL,
	`boot` integer NOT NULL,
	`opened_mono` integer NOT NULL,
	`deadline_mono` integer NOT NULL,
	`newest_counter` integer NOT NULL,
	`reply_gateway_id` integer,
	`reply_rate` integer NOT NULL,
	`cause_seq` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`seq` integer PRIMARY KEY NOT NULL,
	`at_ms` integer NOT NULL,
	`clock_ok` integer NOT NULL,
	`kind` text NOT NULL,
	`device_id` integer,
	`cause_seq` integer,
	`value` integer,
	`detail` blob
);
--> statement-breakpoint
CREATE TABLE `device_keys` (
	`device_id` integer PRIMARY KEY NOT NULL,
	`key` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `device_log` (
	`seq` integer PRIMARY KEY NOT NULL,
	`at_ms` integer NOT NULL,
	`clock_ok` integer NOT NULL,
	`device_id` integer NOT NULL,
	`counter` integer NOT NULL,
	`made_ms` integer NOT NULL,
	`level` integer NOT NULL,
	`code` integer NOT NULL,
	`text` blob NOT NULL,
	`repeat_of` integer
);
--> statement-breakpoint
CREATE TABLE `device_state` (
	`device_id` integer PRIMARY KEY NOT NULL,
	`boot` integer NOT NULL,
	`last_seen_mono` integer NOT NULL,
	`last_seen_ms` integer NOT NULL,
	`clock_ok` integer NOT NULL,
	`window` blob,
	`reading` blob,
	`rssi` integer,
	`snr_q` integer,
	`best_gateway_id` integer,
	`uptime_s` integer,
	`estimates` blob
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` integer PRIMARY KEY NOT NULL,
	`address` integer NOT NULL,
	`role` integer NOT NULL,
	`name` text NOT NULL,
	`chip_id` blob NOT NULL,
	`firmware` integer NOT NULL,
	`development` integer NOT NULL,
	`state` integer NOT NULL,
	`added_ms` integer NOT NULL,
	`removed_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_address_unique` ON `devices` (`address`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_name_unique` ON `devices` (`name`);--> statement-breakpoint
CREATE TABLE `gateway_config` (
	`device_id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`status_interval_s` integer NOT NULL,
	`interference_db` integer NOT NULL,
	`interference_s` integer NOT NULL,
	`default_power_dbm` integer NOT NULL,
	`siren_power_dbm` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hub_events` (
	`seq` integer PRIMARY KEY NOT NULL,
	`at_ms` integer NOT NULL,
	`clock_ok` integer NOT NULL,
	`level` text NOT NULL,
	`origin` text NOT NULL,
	`code` text NOT NULL,
	`message` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `hub_keys` (
	`signing_private` blob NOT NULL,
	`signing_public` blob NOT NULL,
	`identity` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `loss_daily` (
	`device_id` integer NOT NULL,
	`day` integer NOT NULL,
	`received` integer NOT NULL,
	`expected` integer NOT NULL,
	PRIMARY KEY(`device_id`, `day`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `rejects` (
	`minute` integer NOT NULL,
	`via` text NOT NULL,
	`reason` text NOT NULL,
	`count` integer NOT NULL,
	`address` integer,
	`sample` blob NOT NULL,
	PRIMARY KEY(`minute`, `via`, `reason`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `rx_event` (
	`seq` integer PRIMARY KEY NOT NULL,
	`at_ms` integer NOT NULL,
	`clock_ok` integer NOT NULL,
	`device_id` integer NOT NULL,
	`type` integer NOT NULL,
	`counter` integer NOT NULL,
	`path` integer NOT NULL,
	`gateway_id` integer,
	`gw_us` integer,
	`rssi` integer,
	`snr_q` integer,
	`rate` integer,
	`body` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rx_routine` (
	`seq` integer PRIMARY KEY NOT NULL,
	`at_ms` integer NOT NULL,
	`clock_ok` integer NOT NULL,
	`device_id` integer NOT NULL,
	`type` integer NOT NULL,
	`counter` integer NOT NULL,
	`path` integer NOT NULL,
	`gateway_id` integer,
	`gw_us` integer,
	`rssi` integer,
	`snr_q` integer,
	`rate` integer,
	`body` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `send_counters` (
	`device_id` integer PRIMARY KEY NOT NULL,
	`resume_point` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sensor_config` (
	`device_id` integer PRIMARY KEY NOT NULL,
	`arm` integer NOT NULL,
	`armed_boot` integer,
	`armed_mono` integer,
	`countdown_s` integer NOT NULL,
	`heartbeat_units` integer NOT NULL,
	`link_check_every` integer NOT NULL,
	`send_rate` integer NOT NULL,
	`reply_rate` integer NOT NULL,
	`reply_rate_fixed` integer NOT NULL,
	`correction_units` integer NOT NULL,
	`correction_fixed` integer NOT NULL,
	`next_channel` integer NOT NULL,
	`next_rate` integer NOT NULL,
	`move_confirmed` integer NOT NULL,
	`move_followed` integer NOT NULL,
	`version` integer NOT NULL,
	`version_history` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `siren_config` (
	`device_id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`wifi_interval_s` integer NOT NULL,
	`lora_check_units` integer NOT NULL,
	`max_sound_s` integer NOT NULL,
	`send_rate` integer NOT NULL,
	`command_rate` integer NOT NULL,
	`site_channel` integer NOT NULL,
	`version_history` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `site` (
	`channel` integer,
	`rate_mask` integer NOT NULL,
	`move_id` integer NOT NULL,
	`move_stage` integer NOT NULL,
	`move_channel` integer,
	`move_rate` integer,
	`move_actor` text,
	`move_requested_ms` integer,
	`move_forced` integer NOT NULL,
	`move_switched_boot` integer,
	`move_switched_mono` integer,
	`wifi_name` blob NOT NULL,
	`wifi_password` blob NOT NULL,
	`countdown_default_s` integer NOT NULL,
	`auto_stop_s` integer NOT NULL,
	`reply_power_dbm` integer NOT NULL,
	`siren_power_dbm` integer NOT NULL,
	`retention_routine_days` integer NOT NULL,
	`retention_event_days` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tx_event` (
	`seq` integer PRIMARY KEY NOT NULL,
	`at_ms` integer NOT NULL,
	`clock_ok` integer NOT NULL,
	`device_id` integer NOT NULL,
	`type` integer NOT NULL,
	`counter` integer NOT NULL,
	`path` integer NOT NULL,
	`gateway_id` integer,
	`request_counter` integer,
	`rate` integer,
	`power` integer,
	`outcome` integer NOT NULL,
	`gw_sent_us` integer,
	`body` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tx_routine` (
	`seq` integer PRIMARY KEY NOT NULL,
	`at_ms` integer NOT NULL,
	`clock_ok` integer NOT NULL,
	`device_id` integer NOT NULL,
	`type` integer NOT NULL,
	`counter` integer NOT NULL,
	`path` integer NOT NULL,
	`gateway_id` integer,
	`request_counter` integer,
	`rate` integer,
	`power` integer,
	`outcome` integer NOT NULL,
	`gw_sent_us` integer,
	`body` blob NOT NULL
);
