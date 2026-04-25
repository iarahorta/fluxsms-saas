-- ============================================================
-- FluxSMS - Migration 011: heartbeat (last_ping)
-- ============================================================

ALTER TABLE public.chips
    ADD COLUMN IF NOT EXISTS last_ping TIMESTAMPTZ;

ALTER TABLE public.partner_profiles
    ADD COLUMN IF NOT EXISTS last_ping TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_chips_last_ping ON public.chips(last_ping);
CREATE INDEX IF NOT EXISTS idx_partner_profiles_last_ping ON public.partner_profiles(last_ping);
