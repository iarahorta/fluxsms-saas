-- Taxa fixa de processamento por pedido de saque (parceiro)
ALTER TABLE public.partner_withdrawal_requests
    ADD COLUMN IF NOT EXISTS fee_brl NUMERIC(10, 2) NOT NULL DEFAULT 5.00,
    ADD COLUMN IF NOT EXISTS net_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS fee_applied_at TIMESTAMPTZ;

UPDATE public.partner_withdrawal_requests
SET net_amount = ROUND((amount - COALESCE(fee_brl, 5))::numeric, 2)
WHERE net_amount IS NULL;
