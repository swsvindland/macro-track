CREATE TABLE `custom_foods` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`barcode` text,
	`food` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `custom_foods_barcode_idx` ON `custom_foods` (`barcode`);--> statement-breakpoint
CREATE TABLE `diary_days` (
	`day` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `food_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`meal` text NOT NULL,
	`food` text NOT NULL,
	`amount` real NOT NULL,
	`portion_label` text NOT NULL,
	`nutrients` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `food_entries_day_idx` ON `food_entries` (`day`);--> statement-breakpoint
CREATE TABLE `nutrition_targets` (
	`effective_day` text PRIMARY KEY NOT NULL,
	`targets` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saved_foods` (
	`id` text PRIMARY KEY NOT NULL,
	`food` text NOT NULL,
	`saved_at` integer NOT NULL
);
