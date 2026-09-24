CREATE TABLE `weight_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`weight_kg` real NOT NULL,
	`measured_at` text NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
