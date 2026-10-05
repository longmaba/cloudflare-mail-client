DROP INDEX `message_org_msgid_uidx`;
--> statement-breakpoint
CREATE INDEX `message_org_msgid_idx` ON `message` (`org_id`, `message_id_header`);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_org_raw_uidx` ON `message` (`org_id`, `r2_raw_key`, `message_id_header`);
--> statement-breakpoint
CREATE TABLE `inbound_receipt` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL REFERENCES `organization`(`id`) ON DELETE CASCADE,
  `mailbox_id` text NOT NULL REFERENCES `mailbox`(`id`) ON DELETE CASCADE,
  `recipient` text NOT NULL,
  `r2_raw_key` text NOT NULL,
  `job_json` text NOT NULL,
  `status` text DEFAULT 'stored' NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `last_error` text,
  `next_attempt_at` integer NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_receipt_raw_recipient_uidx` ON `inbound_receipt` (`org_id`, `r2_raw_key`, `recipient`);
--> statement-breakpoint
CREATE INDEX `inbound_receipt_replay_idx` ON `inbound_receipt` (`status`, `next_attempt_at`);
