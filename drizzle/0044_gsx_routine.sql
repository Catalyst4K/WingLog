CREATE TABLE `gsx_routine` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uuid` text NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gsx_routine_uuid_unique` ON `gsx_routine` (`uuid`);