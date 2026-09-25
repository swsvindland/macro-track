CREATE TABLE `saved_meals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`items` text NOT NULL,
	`created_at` integer NOT NULL
);
