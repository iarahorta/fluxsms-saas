# Runbook: Ingestao SMS

Este runbook e para incidentes do tipo:
"codigo chegou no modem/console, mas nao apareceu no dashboard".

## 1) Health rapido

- `GET /health` -> deve retornar `status: ok`.
- `GET /api/admin/security/sms-ingestion-events?minutes=30&limit=200`
  (JWT de admin raiz) -> validar `summary` e `alert`.

## 2) Leitura dos sinais

- `summary.delivered` subindo -> entrega funcional ok.
- `summary.unmatched_service` alto -> regex/keywords de servico nao reconhecendo SMS.
- `summary.unmatched_activation` alto -> SMS reconhecido, mas sem ativacao waiting compativel.
- `summary.unauthorized` alto -> problema de chave API no worker.

## 3) Queries SQL de suporte

```sql
select id, outcome, reason, activation_id, metadata, created_at
from public.sms_ingestion_events
order by created_at desc
limit 100;
```

```sql
select id, service, status, phone_number, updated_at
from public.activations
where status in ('waiting', 'received')
order by updated_at desc
limit 100;
```

## 4) Acoes padrao

1. Se `unmatched_service` alto:
   - revisar mensagens brutas recentes no worker.
   - ajustar regra de deteccao do servico (keywords/regex).
2. Se `unmatched_activation` alto:
   - validar normalizacao de numero (com/sem 55).
   - validar janela e status `waiting`.
3. Se `unauthorized`:
   - validar `PARTNER_API_KEY` / `HARDWARE_API_KEY` no worker.
   - validar hash na tabela `partner_api_keys`.

## 5) Criterio de encerramento

- `alert.active = false` por pelo menos 30 min.
- `delivered` crescendo sem backlog anormal em `waiting`.
- dashboard exibindo `received` sem desaparecer prematuramente.

