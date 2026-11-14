ALTER TABLE `rx_event` ADD `gw_counter` integer;--> statement-breakpoint
ALTER TABLE `rx_routine` ADD `gw_counter` integer;--> statement-breakpoint
ALTER TABLE `tx_event` ADD `result_counter` integer;--> statement-breakpoint
ALTER TABLE `tx_routine` ADD `result_counter` integer;