CREATE TABLE `navdata_taxi_segment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`icao` text NOT NULL,
	`start_lat` real NOT NULL,
	`start_lon` real NOT NULL,
	`end_lat` real NOT NULL,
	`end_lon` real NOT NULL,
	`name` text,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL
);
