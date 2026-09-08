CREATE TABLE `navdata_procedure` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`icao` text NOT NULL,
	`kind` text NOT NULL,
	`identifier` text NOT NULL,
	`transition` text,
	`runway_idents_json` text,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `navdata_procedure_leg` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`procedure_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`type` integer NOT NULL,
	`fix_ident` text,
	`fix_type` text,
	`fix_latitude` real NOT NULL,
	`fix_longitude` real NOT NULL,
	`turn_direction` integer NOT NULL,
	`course_deg` real NOT NULL,
	`altitude1` real NOT NULL,
	`altitude2` real NOT NULL,
	`speed_limit` real NOT NULL,
	FOREIGN KEY (`procedure_id`) REFERENCES `navdata_procedure`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `navdata_runway` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`icao` text NOT NULL,
	`ident` text NOT NULL,
	`heading_true_deg` real NOT NULL,
	`length_m` real NOT NULL,
	`width_m` real NOT NULL,
	`surface` integer NOT NULL,
	`threshold_lat` real NOT NULL,
	`threshold_lon` real NOT NULL,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL
);
