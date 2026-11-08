CREATE TABLE `sync_change` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`table_name` text NOT NULL,
	`uuid` text NOT NULL,
	`origin` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_change_table_uuid_idx` ON `sync_change` (`table_name`,`uuid`);