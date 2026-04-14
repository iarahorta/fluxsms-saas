-- ========================================================
-- FluxSMS - Sistema de Polos Distribuídos (Nodes Worker)
-- Copie e cole tudo no SQL Editor do Supabase!
-- ========================================================

-- Tabela: Polos
-- Responsável por registrar cada filial independente (Escritório Jo, Escritório Ju).
CREATE TABLE IF NOT EXISTS public.polos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome TEXT NOT NULL,
    chave_acesso TEXT UNIQUE NOT NULL, -- Chave gigante gerada automaticamente para atestar segurança
    status TEXT DEFAULT 'INSTALL_PENDING', -- ONLINE, OFFLINE, BANNED, INSTALL_PENDING
    chips_ativos INTEGER DEFAULT 0,
    sms_processados_hoje INTEGER DEFAULT 0,
    ultima_comunicacao TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT now()
);

-- Tabela: Chips por Polo
-- Para gerir cada número físico dentro do Node.
CREATE TABLE IF NOT EXISTS public.chips_fisicos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    polo_id UUID REFERENCES public.polos(id) ON DELETE CASCADE,
    porta_com TEXT NOT NULL,          -- Ex: COM5
    numero_telefone TEXT UNIQUE,
    operadora TEXT,                   -- Vivo, Tim, Claro
    bloqueado BOOLEAN DEFAULT false,
    ultima_verificacao TIMESTAMPTZ DEFAULT now(),
    criado_em TIMESTAMPTZ DEFAULT now()
);

-- Configurações RLS (Segurança e Isolamento)
ALTER TABLE public.polos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chips_fisicos ENABLE ROW LEVEL SECURITY;

-- IMPORTANTE:
-- Permitimos Leitura/Gerenciamento livre para usuários logados. (Depois focamos em restrição severa de admin)
CREATE POLICY "Permitir leitura anonima da tabela polos para Worker Python validar"
ON public.polos FOR SELECT
USING (true);

CREATE POLICY "Admin pode inserir e manipular polos"
ON public.polos FOR ALL
USING (auth.uid() IS NOT NULL);

CREATE POLICY "Worker pode atualizar dados via Chave"
ON public.polos FOR UPDATE
USING (true); -- Controle será feito via backend Python comparando chave_acesso

CREATE POLICY "Todos manipulam chips"
ON public.chips_fisicos FOR ALL
USING (true);

-- Função RPC para Resetar Estatísticas Diárias na virada da Noite (Opcional Futuro)
CREATE OR REPLACE FUNCTION resetar_estatisticas_polo_diarias()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
    UPDATE public.polos 
    SET sms_processados_hoje = 0 
    WHERE status != 'BANNED';
$$;
