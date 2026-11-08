-- Custom migration: a change counter for sync (winglog-backend docs/plans/sync-cursors.md). drizzle-kit does not know about triggers: a later
-- migration that recreates one of these tables (the __new_x / DROP / RENAME dance) drops its triggers silently. A unit test checks all twelve exist.
CREATE TRIGGER `sync_change_aircraft_insert` AFTER INSERT ON `aircraft` WHEN NEW.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'aircraft' AND uuid = NEW.uuid;
  INSERT INTO sync_change (table_name, uuid) VALUES ('aircraft', NEW.uuid);
END
--> statement-breakpoint
CREATE TRIGGER `sync_change_aircraft_update` AFTER UPDATE OF updated_at ON `aircraft` WHEN NEW.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'aircraft' AND uuid = NEW.uuid;
  INSERT INTO sync_change (table_name, uuid) VALUES ('aircraft', NEW.uuid);
END
--> statement-breakpoint
CREATE TRIGGER `sync_change_aircraft_delete` AFTER DELETE ON `aircraft` WHEN OLD.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'aircraft' AND uuid = OLD.uuid;
END
--> statement-breakpoint
CREATE TRIGGER `sync_change_flight_insert` AFTER INSERT ON `flight` WHEN NEW.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'flight' AND uuid = NEW.uuid;
  INSERT INTO sync_change (table_name, uuid) VALUES ('flight', NEW.uuid);
END
--> statement-breakpoint
CREATE TRIGGER `sync_change_flight_update` AFTER UPDATE OF updated_at ON `flight` WHEN NEW.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'flight' AND uuid = NEW.uuid;
  INSERT INTO sync_change (table_name, uuid) VALUES ('flight', NEW.uuid);
END
--> statement-breakpoint
CREATE TRIGGER `sync_change_flight_delete` AFTER DELETE ON `flight` WHEN OLD.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'flight' AND uuid = OLD.uuid;
END
--> statement-breakpoint
CREATE TRIGGER `sync_change_landing_insert` AFTER INSERT ON `landing` WHEN NEW.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'landing' AND uuid = NEW.uuid;
  INSERT INTO sync_change (table_name, uuid) VALUES ('landing', NEW.uuid);
END
--> statement-breakpoint
CREATE TRIGGER `sync_change_landing_update` AFTER UPDATE OF updated_at ON `landing` WHEN NEW.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'landing' AND uuid = NEW.uuid;
  INSERT INTO sync_change (table_name, uuid) VALUES ('landing', NEW.uuid);
END
--> statement-breakpoint
CREATE TRIGGER `sync_change_landing_delete` AFTER DELETE ON `landing` WHEN OLD.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'landing' AND uuid = OLD.uuid;
END
--> statement-breakpoint
CREATE TRIGGER `sync_change_flight_invoice_insert` AFTER INSERT ON `flight_invoice` WHEN NEW.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'flightInvoice' AND uuid = NEW.uuid;
  INSERT INTO sync_change (table_name, uuid) VALUES ('flightInvoice', NEW.uuid);
END
--> statement-breakpoint
CREATE TRIGGER `sync_change_flight_invoice_update` AFTER UPDATE OF updated_at ON `flight_invoice` WHEN NEW.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'flightInvoice' AND uuid = NEW.uuid;
  INSERT INTO sync_change (table_name, uuid) VALUES ('flightInvoice', NEW.uuid);
END
--> statement-breakpoint
CREATE TRIGGER `sync_change_flight_invoice_delete` AFTER DELETE ON `flight_invoice` WHEN OLD.uuid IS NOT NULL
BEGIN
  DELETE FROM sync_change WHERE table_name = 'flightInvoice' AND uuid = OLD.uuid;
END
--> statement-breakpoint
INSERT INTO sync_change (table_name, uuid) SELECT 'aircraft', uuid FROM `aircraft` WHERE uuid IS NOT NULL ORDER BY updated_at, id
--> statement-breakpoint
INSERT INTO sync_change (table_name, uuid) SELECT 'flight', uuid FROM `flight` WHERE uuid IS NOT NULL ORDER BY updated_at, id
--> statement-breakpoint
INSERT INTO sync_change (table_name, uuid) SELECT 'landing', uuid FROM `landing` WHERE uuid IS NOT NULL ORDER BY updated_at, id
--> statement-breakpoint
INSERT INTO sync_change (table_name, uuid) SELECT 'flightInvoice', uuid FROM `flight_invoice` WHERE uuid IS NOT NULL ORDER BY updated_at, id
