-- 028: trilha de auditoria para ingestao SMS (entregue/descartado/erro).

CREATE TABLE IF NOT EXISTS public.sms_ingestion_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source TEXT NOT NULL DEFAULT 'sms.deliver',
    outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'discarded', 'error', 'unauthorized')),
    reason TEXT,
    activation_id UUID,
    chip_porta TEXT,
    api_key_hash TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_ingestion_events_created_at
    ON public.sms_ingestion_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sms_ingestion_events_activation_id
    ON public.sms_ingestion_events (activation_id);

COMMENT ON TABLE public.sms_ingestion_events IS
    'Auditoria de ingestao SMS: registra entregas, descartes e erros do endpoint /sms/deliver.';

ALTER TABLE public.sms_ingestion_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sms_ingestion_events_admin_select" ON public.sms_ingestion_events;
CREATE POLICY "sms_ingestion_events_admin_select"
    ON public.sms_ingestion_events FOR SELECT
    USING (public.is_flux_admin_by_profile());

DROP POLICY IF EXISTS "sms_ingestion_events_backend_insert" ON public.sms_ingestion_events;
CREATE POLICY "sms_ingestion_events_backend_insert"
    ON public.sms_ingestion_events FOR INSERT
    WITH CHECK (true);

