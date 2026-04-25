-- Partner service toggles (controle por API key/partner_id)
ALTER TABLE public.partner_service_costs
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill defensivo
UPDATE public.partner_service_costs
SET enabled = TRUE
WHERE enabled IS NULL;
