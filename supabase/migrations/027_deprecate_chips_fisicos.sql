-- 027: marca public.chips_fisicos como legado para reduzir ambiguidade.
-- Fonte oficial do fluxo atual: public.chips.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'chips_fisicos'
    ) THEN
        COMMENT ON TABLE public.chips_fisicos IS
            'LEGADO: tabela mantida por compatibilidade histórica. Nao utilizada no fluxo principal. Fonte oficial atual: public.chips.';
    END IF;
END $$;

