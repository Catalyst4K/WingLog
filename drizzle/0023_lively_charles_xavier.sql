DROP INDEX `landing_flight_id_unique`;--> statement-breakpoint
ALTER TABLE `landing` ADD `seq` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `landing` ADD `icao` text;--> statement-breakpoint
UPDATE `landing` SET `icao` = (SELECT `arr_icao` FROM `flight` WHERE `flight`.`id` = `landing`.`flight_id`) WHERE `icao` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `landing_flight_id_seq_idx` ON `landing` (`flight_id`,`seq`);