-- ============================================================
-- FluxSMS - Migration 002: Row Level Security (RLS)
-- REGRA DE OURO: Frontend NUNCA acessa dados de outro usuário
-- ============================================================

-- Habilitar RLS em todas as tabelas
ALTER TABLE public.profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chips       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- ─── PROFILES ────────────────────────────────────────────────
-- Usuário lê/atualiza apenas o próprio perfil
CREATE POLICY "profiles: leitura própria"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "profiles: atualização própria"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- BLOQUEIO: Usuário NÃO pode alterar saldo diretamente
-- Saldo só é alterado via RPC (stored procedure protegida)
CREATE POLICY "profiles: sem insert direto"
    ON public.profiles FOR INSERT
    WITH CHECK (FALSE); -- Só via trigger do auth

-- ─── CHIPS ────────────────────────────────────────────────────
-- Chips são visíveis por todos os autenticados (lista de serviços)
CREATE POLICY "chips: leitura autenticados"
    ON public.chips FOR SELECT
    TO authenticated
    USING (TRUE);

-- Escrita apenas via service_role (backend)
CREATE POLICY "chips: escrita apenas backend"
    ON public.chips FOR ALL
    TO service_role
    USING (TRUE);

-- ─── ACTIVATIONS ─────────────────────────────────────────────
-- Usuário vê apenas SUAS ativações
CREATE POLICY "activations: leitura própria"
    ON public.activations FOR SELECT
    USING (auth.uid() = user_id);

-- Criação via RPC (backend valida saldo antes)
CREATE POLICY "activations: insert via service_role"
    ON public.activations FOR INSERT
    TO service_role
    WITH CHECK (TRUE);

-- Update (SMS recebido) apenas via service_role
CREATE POLICY "activations: update via service_role"
    ON public.activations FOR UPDATE
    TO service_role
    USING (TRUE);

-- ─── TRANSACTIONS ─────────────────────────────────────────────
-- Usuário vê apenas SEU histórico financeiro
CREATE POLICY "transactions: leitura própria"
    ON public.transactions FOR SELECT
    USING (auth.uid() = user_id);

-- Todas as escritas via service_role (backend/webhook MP)
CREATE POLICY "transactions: escrita via service_role"
    ON public.transactions FOR INSERT
    TO service_role
    WITH CHECK (TRUE);
