-- 026: Reforço de integridade de activations.user_id
-- Objetivo:
-- 1) impedir user_id nulo
-- 2) garantir FK explícita para profiles(id)
-- 3) validar o constraint já existente (ou criar se faltar)

ALTER TABLE public.activations
    ALTER COLUMN user_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'activations_user_id_fkey'
          AND conrelid = 'public.activations'::regclass
    ) THEN
        ALTER TABLE public.activations
            ADD CONSTRAINT activations_user_id_fkey
            FOREIGN KEY (user_id)
            REFERENCES public.profiles(id)
            ON DELETE CASCADE
            NOT VALID;
    END IF;
END $$;

ALTER TABLE public.activations
    VALIDATE CONSTRAINT activations_user_id_fkey;
