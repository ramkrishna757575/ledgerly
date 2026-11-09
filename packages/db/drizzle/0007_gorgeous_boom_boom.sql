CREATE TABLE `manual_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`kind` text NOT NULL,
	`invested` integer,
	`rate_bps` integer,
	`start_date` text,
	`maturity_date` text,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manual_assets_account_id_unique` ON `manual_assets` (`account_id`);