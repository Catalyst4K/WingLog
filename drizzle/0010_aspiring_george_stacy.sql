ALTER TABLE `aircraft` ADD `uuid` text;--> statement-breakpoint
ALTER TABLE `aircraft` ADD `updated_at` text;--> statement-breakpoint
ALTER TABLE `flight` ADD `uuid` text;--> statement-breakpoint
ALTER TABLE `flight` ADD `updated_at` text;--> statement-breakpoint
ALTER TABLE `flight` ADD `flown_route_json` text;--> statement-breakpoint
ALTER TABLE `flight_invoice` ADD `uuid` text;--> statement-breakpoint
ALTER TABLE `flight_invoice` ADD `updated_at` text;--> statement-breakpoint
ALTER TABLE `landing` ADD `uuid` text;--> statement-breakpoint
ALTER TABLE `landing` ADD `updated_at` text;--> statement-breakpoint
-- Backfill for rows that existed before this migration (schema.ts's aircraft.uuid
-- comment explains why this is a plain per-row UPDATE rather than an ALTER TABLE ADD
-- COLUMN default: SQLite evaluates a non-constant ADD COLUMN default once and copies
-- that single value into every existing row, which would give every pre-migration
-- aircraft/flight/landing/invoice the *same* uuid. A per-row UPDATE evaluates the
-- expression separately for each row, same as any other UPDATE ... SET x = expr.
UPDATE `aircraft` SET `uuid` = (
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2)
  || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
), `updated_at` = `created_at` WHERE `uuid` IS NULL;--> statement-breakpoint
UPDATE `flight` SET `uuid` = (
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2)
  || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
), `updated_at` = `created_at` WHERE `uuid` IS NULL;--> statement-breakpoint
UPDATE `landing` SET `uuid` = (
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2)
  || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
), `updated_at` = `touchdown_ts_utc` WHERE `uuid` IS NULL;--> statement-breakpoint
UPDATE `flight_invoice` SET `uuid` = (
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2)
  || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
), `updated_at` = (
  SELECT `created_at` FROM `flight` WHERE `flight`.`id` = `flight_invoice`.`flight_id`
) WHERE `uuid` IS NULL;