-- Custom migration: a row's updated_at written the way SQLite's current_timestamp writes it (2026-09-01 16:50:31: a space, no T, no Z) becomes the ISO time every receiver
-- accepts (2026-09-01T16:50:31.000Z). Migration 0010 backfilled updated_at from created_at, whose default is current_timestamp, so every row from before it has the old form, and
-- the cloud and a twin refuse such a row for good (checkedPeerTime, the Worker's isIsoTimestamp). current_timestamp is UTC, so the time itself is unchanged. The sync_change
-- update triggers (0043, 0045) fire on this UPDATE, so each rewritten row is counted again and goes out to the cloud and to the twins. A NULL updated_at, created_at and
-- deleted_at are left alone; a soft-deleted row is rewritten too, since it syncs as a deletion. A unit test runs this against a database holding old-form rows.
UPDATE `aircraft` SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
WHERE updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
--> statement-breakpoint
UPDATE `flight` SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
WHERE updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
--> statement-breakpoint
UPDATE `landing` SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
WHERE updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
--> statement-breakpoint
UPDATE `flight_invoice` SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
WHERE updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
--> statement-breakpoint
UPDATE `gsx_routine` SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
WHERE updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
