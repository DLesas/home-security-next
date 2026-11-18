CREATE TABLE `hubs` (
	`identity` text PRIMARY KEY NOT NULL,
	`first_seen_ms` integer NOT NULL,
	`days_seen` integer NOT NULL,
	`last_day` integer NOT NULL,
	`seen_ms` integer NOT NULL,
	`state` text NOT NULL,
	`grace_end_ms` integer NOT NULL,
	CONSTRAINT "hubs_state" CHECK("hubs"."state" in ('online', 'quiet', 'alerted'))
);
--> statement-breakpoint
CREATE TABLE `targets` (
	`hub` text NOT NULL,
	`key` text NOT NULL,
	`platform` text NOT NULL,
	`env` text NOT NULL,
	`token` text NOT NULL,
	`unreachable` text NOT NULL,
	`back` text NOT NULL,
	PRIMARY KEY(`hub`, `key`),
	FOREIGN KEY (`hub`) REFERENCES `hubs`(`identity`) ON UPDATE no action ON DELETE cascade
);
