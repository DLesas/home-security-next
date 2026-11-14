CREATE TABLE `backup_key` (
	`key` blob NOT NULL,
	`epoch` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backup_state` (
	`folder` text,
	`hour` integer,
	`keep` integer,
	`last_change_ms` integer,
	`due_since_ms` integer,
	`overdue_raised` integer NOT NULL,
	`newest_name` text,
	`newest_ms` integer,
	`last_result` integer NOT NULL,
	`last_attempt_ms` integer,
	`restored_from_ms` integer
);
--> statement-breakpoint
CREATE TABLE `client_replies` (
	`client_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`reply` blob NOT NULL,
	PRIMARY KEY(`client_id`, `seq`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` integer PRIMARY KEY NOT NULL,
	`person_id` integer,
	`static_key` blob NOT NULL,
	`kind` integer NOT NULL,
	`name` text NOT NULL,
	`linked_by_client` integer,
	`created_ms` integer NOT NULL,
	`removed_ms` integer,
	`last_seq` integer NOT NULL,
	`last_seen_ms` integer,
	`backup_key_epoch` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_static_key_unique` ON `clients` (`static_key`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` integer NOT NULL,
	`sensor_id` integer NOT NULL,
	PRIMARY KEY(`group_id`, `sensor_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `group_sirens` (
	`group_id` integer NOT NULL,
	`siren_id` integer NOT NULL,
	PRIMARY KEY(`group_id`, `siren_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`all_sirens` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_name_unique` ON `groups` (`name`);--> statement-breakpoint
CREATE TABLE `health_state` (
	`device_id` integer PRIMARY KEY NOT NULL,
	`battery_low` integer NOT NULL,
	`tamper_open` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `link_secrets` (
	`token_id` integer PRIMARY KEY NOT NULL,
	`psk` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `link_tokens` (
	`id` integer PRIMARY KEY NOT NULL,
	`lookup` blob NOT NULL,
	`kind` integer NOT NULL,
	`person_id` integer,
	`created_by_client` integer,
	`created_boot` integer NOT NULL,
	`created_mono` integer NOT NULL,
	`expires_after_ms` integer NOT NULL,
	`typed` integer NOT NULL,
	`failures` integer NOT NULL,
	`used_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_tokens_lookup_unused` ON `link_tokens` (`lookup`) WHERE "link_tokens"."used_ms" is null;--> statement-breakpoint
CREATE TABLE `mode_groups` (
	`mode_id` integer NOT NULL,
	`group_id` integer NOT NULL,
	PRIMARY KEY(`mode_id`, `group_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `mode_state` (
	`current_mode_id` integer,
	`mode_modified` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `modes` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`fixed` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `modes_name_unique` ON `modes` (`name`);--> statement-breakpoint
CREATE TABLE `notification_prefs` (
	`client_id` integer PRIMARY KEY NOT NULL,
	`categories` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_reads` (
	`seq` integer PRIMARY KEY NOT NULL,
	`at_ms` integer NOT NULL,
	`clock_ok` integer NOT NULL,
	`notification_seq` integer NOT NULL,
	`client_id` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`seq` integer PRIMARY KEY NOT NULL,
	`at_ms` integer NOT NULL,
	`clock_ok` integer NOT NULL,
	`kind` text NOT NULL,
	`category` text NOT NULL,
	`critical` integer NOT NULL,
	`device_id` integer,
	`cause_seq` integer,
	`recipients` blob NOT NULL,
	`detail` blob
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_ms` integer NOT NULL,
	`removed_ms` integer,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_name_live` ON `people` (`name`) WHERE "people"."removed_ms" is null;--> statement-breakpoint
CREATE TABLE `people_settings` (
	`user_management` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `permissions` (
	`person_id` integer NOT NULL,
	`device_id` integer NOT NULL,
	`manage` integer NOT NULL,
	`view` integer NOT NULL,
	PRIMARY KEY(`person_id`, `device_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `person_roles` (
	`person_id` integer PRIMARY KEY NOT NULL,
	`manage_users` integer NOT NULL,
	`manage_system` integer NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedule_state` (
	`time_zone` text
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`action` integer NOT NULL,
	`mode_id` integer,
	`group_id` integer,
	`sensor_id` integer,
	`local_time` integer NOT NULL,
	`days` integer NOT NULL,
	`date` integer,
	`enabled` integer NOT NULL,
	`created_by` text NOT NULL,
	`last_run_ms` integer,
	`last_run_local_date` integer,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `update_state` (
	`staged_version` text,
	`staged_ms` integer,
	`approved_by` text,
	`approved_ms` integer,
	`switching_ms` integer,
	`previous_version` text
);
--> statement-breakpoint
ALTER TABLE `hub_keys` ADD `app_static_private` blob;--> statement-breakpoint
ALTER TABLE `hub_keys` ADD `app_static_public` blob;--> statement-breakpoint
ALTER TABLE `hub_keys` ADD `tls_private` blob;--> statement-breakpoint
ALTER TABLE `hub_keys` ADD `tls_certificate` blob;--> statement-breakpoint
-- By hand (m2-design.md section 4): the two fixed modes (D90); `mode_state` from the sensors'
-- states: Disarmed if none is armed (a site with no sensor and a new installation too), Away if
-- every one is, otherwise none, with mode_modified set. A sensor waiting for its door counts as
-- armed; a removed device (state 4) counts not at all. Then the other single rows with their
-- defaults; `backup_key` is inserted by `upkeep` at the first start, from the input's entropy.
INSERT INTO `modes` (`id`, `name`, `fixed`, `revision`) VALUES (1, 'Away', 1, 0), (2, 'Disarmed', 2, 0);--> statement-breakpoint
INSERT INTO `mode_state` (`current_mode_id`, `mode_modified`) SELECT
	CASE
		WHEN NOT EXISTS (SELECT 1 FROM `sensor_config` c JOIN `devices` d ON d.`id` = c.`device_id` WHERE d.`state` <> 4 AND c.`arm` <> 0) THEN 2
		WHEN NOT EXISTS (SELECT 1 FROM `sensor_config` c JOIN `devices` d ON d.`id` = c.`device_id` WHERE d.`state` <> 4 AND c.`arm` = 0) THEN 1
		ELSE NULL
	END,
	CASE
		WHEN EXISTS (SELECT 1 FROM `sensor_config` c JOIN `devices` d ON d.`id` = c.`device_id` WHERE d.`state` <> 4 AND c.`arm` <> 0)
		 AND EXISTS (SELECT 1 FROM `sensor_config` c JOIN `devices` d ON d.`id` = c.`device_id` WHERE d.`state` <> 4 AND c.`arm` = 0) THEN 1
		ELSE 0
	END;--> statement-breakpoint
INSERT INTO `people_settings` (`user_management`) VALUES (0);--> statement-breakpoint
INSERT INTO `schedule_state` (`time_zone`) VALUES (NULL);--> statement-breakpoint
INSERT INTO `backup_state` (`overdue_raised`, `last_result`) VALUES (0, 0);
