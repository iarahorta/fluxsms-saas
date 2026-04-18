-- ============================================================
-- FluxSMS - Migration 005: Admin Fixes & Service Config
-- ============================================================

-- Tabela de Configuração Global de Preços
CREATE TABLE IF NOT EXISTS public.services_config (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Popula com os serviços padrão if not exists
INSERT INTO public.services_config (id, name, price)
VALUES 
    ('whatsapp', 'WhatsApp', 6.10),
    ('telegram', 'Telegram', 4.00),
    ('google', 'Google / YT', 1.50),
    ('uber', 'Uber', 1.20),
    ('tinder', 'Tinder', 4.50),
    ('gov', 'GOV.BR', 5.00),
    ('ifood', 'iFood', 0.90),
    ('instagram', 'Instagram', 2.00),
    ('tiktok', 'TikTok', 1.50),
    ('apple', 'Apple ID', 3.00),
    ('shopee', 'Shopee', 0.80),
    ('mercadolivre', 'Mercado Livre', 1.20),
    ('nubank', 'Nubank', 2.50),
    ('twitter', 'X (Twitter)', 1.00),
    ('paypal', 'PayPal', 2.00)
ON CONFLICT (id) DO NOTHING;

-- RLS para services_config
ALTER TABLE public.services_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "services_config_select_all" ON public.services_config;
CREATE POLICY "services_config_select_all" ON public.services_config FOR SELECT USING (TRUE);
DROP POLICY IF EXISTS "services_config_admin_all" ON public.services_config;
CREATE POLICY "services_config_admin_all" ON public.services_config FOR ALL USING (
    (auth.jwt() ->> 'email' = 'iarachorta@gmail.com')
);

-- Realtime para services_config
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'services_config') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.services_config;
    END IF;
END $$;
