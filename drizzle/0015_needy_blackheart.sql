ALTER TABLE `aircraft` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `flight` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `flight_invoice` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `landing` ADD `deleted_at` text;