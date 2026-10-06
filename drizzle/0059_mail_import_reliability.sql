ALTER TABLE `mail_import` ADD `source_format` text DEFAULT 'mbox' NOT NULL;
--> statement-breakpoint
ALTER TABLE `mail_import` ADD `lease_token` text;
--> statement-breakpoint
ALTER TABLE `mail_import` ADD `lease_until` integer;
--> statement-breakpoint
ALTER TABLE `mail_import` ADD `attempts` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `mail_import` ADD `next_attempt_at` integer;
--> statement-breakpoint
CREATE INDEX `mail_import_recovery_idx` ON `mail_import` (`status`, `next_attempt_at`, `lease_until`);
--> statement-breakpoint
CREATE TABLE `mail_import_message` (
  `import_id` text NOT NULL REFERENCES `mail_import`(`id`) ON DELETE CASCADE,
  `offset` integer NOT NULL,
  `end_offset` integer NOT NULL,
  `outcome` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_import_message_offset_uidx` ON `mail_import_message` (`import_id`, `offset`);
--> statement-breakpoint
CREATE TABLE `mail_import_part` (
  `import_id` text NOT NULL REFERENCES `mail_import`(`id`) ON DELETE CASCADE,
  `index` integer NOT NULL,
  `size_bytes` integer NOT NULL,
  `sha256` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_import_part_index_uidx` ON `mail_import_part` (`import_id`, `index`);
