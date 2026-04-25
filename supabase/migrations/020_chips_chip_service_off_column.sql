-- Coluna exigida por rpc_solicitar_sms_v3 (015/018) e por routes/sms.js (multicanal).
-- Se viste: "column c.chip_service_off does not exist" → esta migração não tinha sido aplicada
-- (faz parte do bloco 014; aqui fica isolada para correr só o essencial).

ALTER TABLE public.chips
    ADD COLUMN IF NOT EXISTS chip_service_off JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.chips.chip_service_off IS 'Por serviço (ex. whatsapp): true = canal desligado para novas vendas; chip pode continuar idle para outros serviços.';
