CREATE TABLE `device_updates` (
	`device_id` integer PRIMARY KEY NOT NULL,
	`rollout_id` integer,
	`same_version` integer DEFAULT 0 NOT NULL,
	`state` integer NOT NULL,
	`method` integer NOT NULL,
	`held` integer NOT NULL,
	`bytes` integer NOT NULL,
	`attempts` integer NOT NULL,
	`last_reason` integer,
	`since_ms` integer NOT NULL,
	`ble_nonce` blob,
	`ble_expires_ms` integer,
	`reminded_ms` integer
);
--> statement-breakpoint
CREATE TABLE `firmware_images` (
	`id` integer PRIMARY KEY NOT NULL,
	`image_id` blob NOT NULL,
	`sha256` blob NOT NULL,
	`version` integer NOT NULL,
	`kind` integer NOT NULL,
	`roles` integer NOT NULL,
	`bytes` integer NOT NULL,
	`header` blob NOT NULL,
	`manifest` text,
	`file` text NOT NULL,
	`added_ms` integer NOT NULL,
	`added_by` text NOT NULL,
	`removed_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `firmware_images_image_id_live` ON `firmware_images` (`image_id`) WHERE "firmware_images"."removed_ms" is null;--> statement-breakpoint
CREATE TABLE `push_keys` (
	`client_id` integer PRIMARY KEY NOT NULL,
	`key` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_outbox` (
	`id` integer PRIMARY KEY NOT NULL,
	`notification_seq` integer NOT NULL,
	`client_id` integer NOT NULL,
	`created_ms` integer NOT NULL,
	`attempts` integer NOT NULL,
	`armed` integer DEFAULT 0 NOT NULL,
	`facts` text
);
--> statement-breakpoint
CREATE TABLE `push_targets` (
	`client_id` integer PRIMARY KEY NOT NULL,
	`key_id` blob NOT NULL,
	`platform` integer NOT NULL,
	`environment` integer NOT NULL,
	`token` text NOT NULL,
	`registered_ms` integer NOT NULL,
	`invalid_ms` integer
);
--> statement-breakpoint
CREATE TABLE `relay_settings` (
	`url` text,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rollouts` (
	`id` integer PRIMARY KEY NOT NULL,
	`image` integer NOT NULL,
	`devices` blob NOT NULL,
	`pilots` blob NOT NULL,
	`stage` integer NOT NULL,
	`approved_by` text NOT NULL,
	`approved_ms` integer NOT NULL,
	`soak_until_ms` integer,
	`paused_reason` integer,
	`paused_device` integer,
	`ended_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rollouts_one_open` ON `rollouts` (("ended_ms" IS NULL)) WHERE "rollouts"."ended_ms" is null;--> statement-breakpoint
ALTER TABLE `device_keys` ADD `next_key` blob;--> statement-breakpoint
ALTER TABLE `device_keys` ADD `rekey` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rx_event` ADD `old_key` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `rx_routine` ADD `old_key` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- By hand (docs/m4-design.md section 4): `relay_settings`' single row, the deployment's default relay.
INSERT INTO `relay_settings` (`url`, `revision`) VALUES (NULL, 0);
