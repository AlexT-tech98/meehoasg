-- Store unverified bill images linked to orders without auto-confirming payment or full-paid status.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS unverified_bill_urls jsonb NOT NULL DEFAULT '[]'::jsonb;
