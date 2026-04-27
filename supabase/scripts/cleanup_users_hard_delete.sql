-- =============================================================================
-- Limpeza dura: remover utilizadores Auth + profiles + dados ligados (teste).
-- Executar no Supabase → SQL Editor (role com permissão em auth.users).
--
-- LISTA FIXA (ajuste se necessário): estes 3 UUIDs = auth.users.id = profiles.id
--   e@gmail.com
--   desktop@gmail.com (parceiro desktop_c2bface4)
--   dhsolucoesdigital001@gmail.com
--
-- AVISO: irreversível. Revê os UUIDs antes de correr. Faz backup se ainda houver dúvida.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE _flux_cleanup_user (id UUID PRIMARY KEY ON COMMIT DROP);

INSERT INTO _flux_cleanup_user (id) VALUES
  ('d50489f1-7e25-49ed-8f7a-843f527ea2b1'::uuid),
  ('4399466e-64d0-40ea-a946-84b94f6cac7b'::uuid),
  ('92eaf7c0-3f7e-4866-9ef7-4095393d9b56'::uuid);

CREATE TEMP TABLE _flux_cleanup_partner (id UUID PRIMARY KEY ON COMMIT DROP);

INSERT INTO _flux_cleanup_partner (id)
SELECT pp.id
FROM public.partner_profiles pp
WHERE pp.user_id IN (SELECT id FROM _flux_cleanup_user);

-- 1) Transações destes utilizadores (activations referenciadas em seguida)
DELETE FROM public.transactions t
WHERE t.user_id IN (SELECT id FROM _flux_cleanup_user);

-- 2) Activações: filas do cliente + qualquer SMS ligada a chips dos polos destes parceiros
DELETE FROM public.activations a
WHERE a.user_id IN (SELECT id FROM _flux_cleanup_user);

DELETE FROM public.activations a
WHERE a.chip_id IN (
  SELECT c.id
  FROM public.chips c
  INNER JOIN public.polos p ON p.id = c.polo_id
  WHERE p.partner_profile_id IN (SELECT id FROM _flux_cleanup_partner)
);

-- 3) Chips dos polos do parceiro (antes de apagar polos)
DELETE FROM public.chips c
USING public.polos p
WHERE c.polo_id = p.id
  AND p.partner_profile_id IN (SELECT id FROM _flux_cleanup_partner);

-- 4) Polos só destes partner_profiles (outros polos não são tocados)
DELETE FROM public.polos p
WHERE p.partner_profile_id IN (SELECT id FROM _flux_cleanup_partner);

-- 5) partner_profiles / chaves / custos: em geral CASCADE ao apagar profile,
--    mas garantimos que não ficam referências quebradas aos polos acima.

-- 6) Auth: apaga utilizador; CASCADE em public.profiles e partner_profiles ligados
DELETE FROM auth.users u
WHERE u.id IN (SELECT id FROM _flux_cleanup_user);

COMMIT;

-- Verificação rápida (correr à parte, deve devolver 0 linhas para estes e-mails):
-- SELECT id, email FROM public.profiles WHERE id IN (
--   'd50489f1-7e25-49ed-8f7a-843f527ea2b1',
--   '4399466e-64d0-40ea-a946-84b94f6cac7b',
--   '92eaf7c0-3f7e-4866-9ef7-4095393d9b56'
-- );
-- SELECT id, email FROM auth.users WHERE id IN (...);
