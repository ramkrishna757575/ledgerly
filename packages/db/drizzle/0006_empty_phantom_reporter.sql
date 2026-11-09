CREATE TABLE `analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`destination` text NOT NULL,
	`snapshot` text NOT NULL,
	`output` text NOT NULL
);
