CREATE TABLE `navdata_stand` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`icao` text NOT NULL,
	`name` text NOT NULL,
	`name_code` integer NOT NULL,
	`number` integer NOT NULL,
	`suffix` integer NOT NULL,
	`heading_deg` real NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `flight` ADD `parked_stand_icao` text;--> statement-breakpoint
ALTER TABLE `flight` ADD `parked_stand` text;