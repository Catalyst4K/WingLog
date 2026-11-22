-- Hand-written in place of the three ADD COLUMNs drizzle-kit generated (origin_ident, origin_latitude, origin_longitude): 1.7.2 shipped those columns
-- as its own migration 0041, so a 1.7.2 database that upgrades here already has them, and a plain ADD would fail with "duplicate column". A v2
-- development database (already past v2's 0047) never had them. Rebuilding the table works for both shapes, and for a fresh database: copy the columns
-- every shape has, leave the three origin columns empty (null, so every airport with an FD leg is fetched again for its recommended navaid, which is
-- what a cache from before the columns means). Nothing references navdata_procedure_leg, and the cache can always be fetched again.
-- winglog-backend docs/plans/fd-leg-dme-navaid.md, "Into v2".
CREATE TABLE `__new_navdata_procedure_leg` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`procedure_id` integer NOT NULL,
	`runway_ident` text,
	`transition_name` text,
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
	`route_distance_m` real DEFAULT 0 NOT NULL,
	`origin_ident` text,
	`origin_latitude` real,
	`origin_longitude` real,
	FOREIGN KEY (`procedure_id`) REFERENCES `navdata_procedure`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_navdata_procedure_leg`(`id`, `procedure_id`, `runway_ident`, `transition_name`, `seq`, `type`, `fix_ident`, `fix_type`, `fix_latitude`, `fix_longitude`, `turn_direction`, `course_deg`, `altitude1`, `altitude2`, `speed_limit`, `route_distance_m`) SELECT `id`, `procedure_id`, `runway_ident`, `transition_name`, `seq`, `type`, `fix_ident`, `fix_type`, `fix_latitude`, `fix_longitude`, `turn_direction`, `course_deg`, `altitude1`, `altitude2`, `speed_limit`, `route_distance_m` FROM `navdata_procedure_leg`;
--> statement-breakpoint
DROP TABLE `navdata_procedure_leg`;
--> statement-breakpoint
ALTER TABLE `__new_navdata_procedure_leg` RENAME TO `navdata_procedure_leg`;
--> statement-breakpoint
CREATE INDEX `navdata_procedure_leg_procedure_id_idx` ON `navdata_procedure_leg` (`procedure_id`);
