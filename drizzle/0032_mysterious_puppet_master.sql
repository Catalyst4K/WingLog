CREATE INDEX `flight_aircraft_id_idx` ON `flight` (`aircraft_id`);--> statement-breakpoint
CREATE INDEX `flight_status_idx` ON `flight` (`status`);--> statement-breakpoint
CREATE INDEX `flight_invoice_flight_id_idx` ON `flight_invoice` (`flight_id`);--> statement-breakpoint
CREATE INDEX `navdata_procedure_icao_kind_idx` ON `navdata_procedure` (`icao`,`kind`);--> statement-breakpoint
CREATE INDEX `navdata_procedure_leg_procedure_id_idx` ON `navdata_procedure_leg` (`procedure_id`);--> statement-breakpoint
CREATE INDEX `navdata_runway_icao_idx` ON `navdata_runway` (`icao`);--> statement-breakpoint
CREATE INDEX `navdata_stand_icao_idx` ON `navdata_stand` (`icao`);--> statement-breakpoint
CREATE INDEX `navdata_taxi_segment_icao_idx` ON `navdata_taxi_segment` (`icao`);--> statement-breakpoint
CREATE INDEX `track_point_flight_id_idx` ON `track_point` (`flight_id`);