CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor" text NOT NULL,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"account" text NOT NULL,
	"account_memo" text,
	"client_domain" text,
	"asset_code" text NOT NULL,
	"asset_issuer" text NOT NULL,
	"amount_in" text,
	"amount_out" text,
	"amount_fee" text,
	"to_account" text,
	"from_account" text,
	"withdraw_anchor_account" text,
	"withdraw_memo" text,
	"withdraw_mode" text,
	"escrow_tx_id" text,
	"escrow" jsonb,
	"deposit_instructions" jsonb,
	"stellar_transaction_id" text,
	"external_transaction_id" text,
	"message" text,
	"refunds" jsonb,
	"on_change_callback" text,
	"lang" text,
	"customer" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_provider_event_id_pk" PRIMARY KEY("provider","event_id")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_transaction_idx" ON "audit_log" USING btree ("transaction_id","id");--> statement-breakpoint
CREATE INDEX "transactions_account_started_idx" ON "transactions" USING btree ("account","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_withdraw_memo_idx" ON "transactions" USING btree ("withdraw_memo");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_escrow_tx_id_idx" ON "transactions" USING btree ("escrow_tx_id");