-- Isolamento de chips por Partner API Key (listagens / worker por dispositivo).
-- Chips existentes: atribuição à chave ativa mais antiga do mesmo parceiro do polo (heurística única).

ALTER TABLE public.chips
    ADD COLUMN IF NOT EXISTS registered_by_api_key_id UUID REFERENCES public.partner_api_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_chips_registered_by_api_key
    ON public.chips(registered_by_api_key_id)
    WHERE registered_by_api_key_id IS NOT NULL;

COMMENT ON COLUMN public.chips.registered_by_api_key_id IS 'Chave API que registou/atualiza este chip; listagens Partner API filtram por este campo.';

UPDATE public.chips c
SET registered_by_api_key_id = sub.key_id
FROM (
    SELECT
        c2.id AS chip_id,
        (
            SELECT k.id
            FROM public.partner_api_keys k
            INNER JOIN public.polos p ON p.partner_profile_id = k.partner_id
            WHERE p.id = c2.polo_id
              AND k.is_active = TRUE
            ORDER BY k.created_at ASC NULLS LAST
            LIMIT 1
        ) AS key_id
    FROM public.chips c2
    WHERE c2.registered_by_api_key_id IS NULL
      AND EXISTS (SELECT 1 FROM public.polos p3 WHERE p3.id = c2.polo_id)
) AS sub
WHERE c.id = sub.chip_id
  AND sub.key_id IS NOT NULL;
