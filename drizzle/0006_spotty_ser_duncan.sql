CREATE TABLE `check_ins` (
	`day` text PRIMARY KEY NOT NULL,
	`goal_id` integer NOT NULL,
	`decision` text NOT NULL,
	`review` text NOT NULL,
	`targets` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `coaching_goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mode` text NOT NULL,
	`pace` real NOT NULL,
	`started_day` text NOT NULL
);
