-- Custom migration: GSX routines sync like the logbook (winglog-backend docs/plans/gsx-routines-sync.md). First the three change triggers for the new table
-- (drizzle-kit does not know about triggers; a unit test checks they exist), then the routines the pilot already has are copied from the two settings that held
-- them (the routines, and the built-ins deleted) into rows, so the triggers count them and they reach the other computers. The settings are left in place and no longer read.
CREATE TRIGGER `sync_change_gsx_routine_insert` AFTER INSERT ON `gsx_routine` WHEN NEW.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'gsxRoutine' AND uuid = NEW.uuid;
  INSERT INTO sync_change (table_name, uuid) VALUES ('gsxRoutine', NEW.uuid);
END
--> statement-breakpoint
CREATE TRIGGER `sync_change_gsx_routine_update` AFTER UPDATE OF updated_at ON `gsx_routine` WHEN NEW.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'gsxRoutine' AND uuid = NEW.uuid;
  INSERT INTO sync_change (table_name, uuid) VALUES ('gsxRoutine', NEW.uuid);
END
--> statement-breakpoint
CREATE TRIGGER `sync_change_gsx_routine_delete` AFTER DELETE ON `gsx_routine` WHEN OLD.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'gsxRoutine' AND uuid = OLD.uuid;
END
--> statement-breakpoint
INSERT OR IGNORE INTO `gsx_routine` (`uuid`, `kind`, `data`, `updated_at`)
SELECT json_extract(j.value, '$.id'), 'routine', j.value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (SELECT value FROM app_setting WHERE key = 'gsxRoutines' AND json_valid(value) AND json_type(value) = 'array') AS s,
     json_each(s.value) AS j
WHERE j.type = 'object' AND json_type(j.value, '$.id') = 'text' AND length(json_extract(j.value, '$.id')) BETWEEN 1 AND 64
--> statement-breakpoint
INSERT OR IGNORE INTO `gsx_routine` (`uuid`, `kind`, `data`, `updated_at`)
SELECT 'hidden-' || j.value, 'hidden', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (SELECT value FROM app_setting WHERE key = 'gsxRoutinesHidden' AND json_valid(value) AND json_type(value) = 'array') AS s,
     json_each(s.value) AS j
WHERE j.type = 'text' AND length(j.value) BETWEEN 1 AND 64
