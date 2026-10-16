-- Idempotent schema baseline required by the production delete queue RPC.
-- These columns already exist in production; this brings fresh CI databases into parity.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delete_after_sheet_sync boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS delete_requested_by text,
  ADD COLUMN IF NOT EXISTS delete_requested_at timestamptz;
