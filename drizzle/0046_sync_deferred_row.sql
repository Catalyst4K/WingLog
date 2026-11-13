CREATE TABLE `sync_deferred_row` (
	`peer` text NOT NULL,
	`table_name` text NOT NULL,
	`uuid` text NOT NULL,
	`updated_at` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_deferred_row_key_idx` ON `sync_deferred_row` (`peer`,`table_name`,`uuid`);