CREATE TABLE `alert_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer,
	`date` text NOT NULL,
	`description` text NOT NULL,
	`amount` integer NOT NULL,
	`last4` text NOT NULL,
	`reference` text,
	`fingerprint` text NOT NULL,
	`sender` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`transaction_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_entries_fingerprint_unique` ON `alert_entries` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `alert_entries_status_idx` ON `alert_entries` (`status`);