CREATE TABLE `recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`servings` real NOT NULL,
	`ingredients` text NOT NULL,
	`revision` integer NOT NULL
);
