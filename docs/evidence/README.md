# Evidências dos experimentos

Os arquivos desta pasta registram observações históricas. Seus horários identificam a execução original; exportar ou conferir um arquivo não constitui nova execução do experimento.

| Arquivo | Conteúdo |
| --- | --- |
| [hpa-evidence-2026-11-08.json](hpa-evidence-2026-11-08.json) | 31 amostras da elasticidade por CPU: 1 → 3 → 5 → 4 → 3 → 2 → 1, com métricas, condições, estados da aplicação e métricas dos Pods. |
| [hpa-evidence-2026-11-13.json](hpa-evidence-2026-11-13.json) | 32 amostras da revalidação ao vivo, com o mesmo ciclo de réplicas e 637 batalhas concluídas sem falhas. |
| [delivery-validation-2026-11-13.json](delivery-validation-2026-11-13.json) | Estado final dos ambientes, oito testes de integração aprovados, parâmetros, transições e hash da nova coleta HPA. |
| [presentation-validation-2026-11-13.json](presentation-validation-2026-11-13.json) | Verificação do histórico visual em Compose e Kubernetes, coleta real e downloads JSON/CSV; distingue os cenários isolados de interface de um ciclo real do HPA. |
| [readiness-validation-2026-11-13.json](readiness-validation-2026-11-13.json) | Doze verificações reais aprovadas pelo script de preparação, incluindo prontidão, volumes, métricas, perfil HPA e filas drenadas; snapshot histórico, não garantia de disponibilidade futura. |
| [requirements-results.json](requirements-results.json) | Recuperação durante falha e nove medições de escala manual de 09/11/2026. |
| [control-room-results.json](control-room-results.json) | Validação da Sala de Controle e lote de 100 batalhas de 10/11/2026, com HPA fixo em cinco workers. |

## Origem das amostras do HPA

O arquivo `hpa-evidence-2026-11-08.json` foi exportado em 13/11/2026 de `.git/local-cluster/hpa-evidence.json`. Seus bytes foram preservados. `.gitattributes` desabilita a conversão de finais de linha desses arquivos para manter o hash também após um clone. A revisão dos campos e valores não encontrou senhas, tokens, chaves privadas ou URLs com credenciais; o arquivo contém observações operacionais do cluster local.

SHA-256: `0fcad7236b60f5e24dd4206ed7ff55fd5c70917c0094a68ec5d57ebbfea5caff`.

O hash permite conferir a integridade da cópia; não constitui assinatura nem autenticação independente da coleta. O [relato do experimento](../kubernetes-validation.md) explica parâmetros e limites. O pico de 398% é relativo ao request de CPU de cada worker, não à CPU total do host.

Para conferir a cópia no PowerShell:

```powershell
Get-FileHash docs/evidence/hpa-evidence-2026-11-08.json -Algorithm SHA256
```

## Revalidação de 13/11/2026

O arquivo `hpa-evidence-2026-11-13.json` preserva os bytes da nova coleta local de mesmo nome, revisada sem encontrar credenciais. SHA-256: `9946dd554dffbae255d08c4c83a24af07f8c41260180439d70728da96cea2d15`.

Foram observadas 32 amostras, retorno a uma réplica aos 470 segundos do observador, pico de CPU de 398% do request e fila/outbox vazias ao final. A carga durou aproximadamente 120 segundos e começou depois da primeira amostra. As 637 batalhas do request ID `hpa-6a1bca01104d4820aa858c80aabe75e2` foram conferidas por paginação da API pública: 637 IDs únicos, todos concluídos, com cinco workers distintos.

O [roteiro e os resultados da entrega](../delivery-validation.md) descrevem o ambiente. Esta execução demonstra elasticidade; não é um ensaio repetido de desempenho.
