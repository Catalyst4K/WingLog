ALTER TABLE `track_point` ADD `resume_segment` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `track_point` ADD `sim_rate` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `track_point` ADD `excluded_reason` text;