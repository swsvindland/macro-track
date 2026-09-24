CREATE TABLE `health_links` (
	`key` text PRIMARY KEY NOT NULL,
	`local_kind` text NOT NULL,
	`local_id` integer NOT NULL,
	`remote_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`origin` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `measurements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`measured_at` text NOT NULL,
	`values` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uri` text NOT NULL,
	`pose` text NOT NULL,
	`measured_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `preferences` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
