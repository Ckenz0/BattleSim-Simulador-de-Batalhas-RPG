# Certificação técnica da implementação

Registro das verificações da arquitetura e dos comportamentos do BattleSim, realizadas em 07–13/11/2026 no ambiente local Docker Desktop, com Compose e Kubernetes. Os resultados se aplicam às configurações e execuções documentadas; não representam certificação externa, alta disponibilidade ou previsão de desempenho em produção.

Os relatórios distinguem configuração estática, observação em execução e evidência histórica. Uma conferência de arquivo não constitui nova execução do experimento. O estado atual deve ser consultado com `scripts/Prepare-Presentation.ps1`.

## Arquitetura e isolamento

| Propriedade técnica | Verificação e evidência |
| --- | --- |
| Quatro componentes no Compose | NGINX, Serviço A, Serviço B e RabbitMQ em [compose.yml](../compose.yml), com Dockerfiles separados para API e worker. |
| Entrada externa exclusiva pelo NGINX | Somente NGINX publica porta no host. API, worker e broker usam a rede interna; exporter RabbitMQ não possui porta publicada. |
| Comunicação assíncrona entre API e worker | Tarefas em `battles.requests.v1` e eventos em `battles.events.v1`; não há chamada HTTP direta entre A/B no processamento da batalha. [Arquitetura](architecture.md) e [contratos](../contracts/battle_contracts/models.py). |
| Aceitação transacional | API persiste a batalha e sua intenção de publicação na outbox na mesma transação SQLite. [Persistência](../service-a/api/database.py). |
| Durabilidade e confirmações | Filas duráveis, mensagens persistentes, publicação obrigatória e publisher confirms. O worker confirma a tarefa após publicar o resultado; a API confirma o evento após persistir. [Broker](../contracts/battle_contracts/broker.py). |
| Deduplicação e resultado idempotente | Reentregas não criam um segundo resultado aceito nem duplicam recompensas da aventura. Testes de banco, eventos, worker e trace cobrem esses comportamentos. |
| Correlação e percurso persistido | `request_id`, `battle_id`, `worker_id`, tentativas e observações disponíveis nos logs e no [Percurso](control-room.md). Registros anteriores ao trace mantêm cobertura explicitamente parcial. |
| Credenciais fora dos arquivos versionados | `.env` ignorado; exemplo com placeholder e geração de Secret por [New-Secret.ps1](../k8s/New-Secret.ps1). Não há Secret com valores reais nos manifests. |

## Implantação, recuperação e escala

| Propriedade técnica | Resultado observado |
| --- | --- |
| Consumidor interrompido e retomada | Oito testes reais de integração Compose aprovados em 13/11, incluindo consumidor parado, recuperação do broker, persistência e escala de workers. [Registro da execução](delivery-validation.md). |
| Kubernetes declarativo | Deployments de API/worker/frontend, Services internos, Ingress NGINX e RabbitMQ StatefulSet com PVC. Os cinco perfis Kustomize passaram nos guardrails estáticos. [Configuração](../k8s/README.md). |
| Persistência local | PVCs `api-data` e `data-rabbitmq-0` Bound, preservados durante as atualizações e verificações. A API permanece em uma réplica com estratégia Recreate e SQLite. |
| Reposição automática de Pod | Substituição com UID novo documentada na [validação Kubernetes](kubernetes-validation.md). O ensaio de falha sob carga registrou 100 resultados únicos, zero falhas e 20 reexecuções após remoção de worker. [Resultados](requirements-results.md). |
| Escala manual controlada | Três medições por cenário de 1, 3 e 5 workers. Medianas de 84,67 s, 28,69 s e 18,56 s por lote de cem batalhas, com a mesma configuração entre cenários. [Método e limites](requirements-results.md). |
| HPA por CPU | `autoscaling/v2`, alvo de 60% do request de 250m, mínimo 1 e máximo 5; carga real PBKDF2 no worker. [Manifesto](../k8s/base/worker-hpa.yaml). |
| Aumento e redução automáticos | Execução de 13/11 observou 1 → 3 → 5 → 4 → 3 → 2 → 1, com 637 batalhas concluídas, zero falhas e backlog final zero. [32 amostras brutas](evidence/hpa-evidence-2026-11-13.json). |
| Integridade das evidências HPA | 31 amostras originais e 32 amostras da revalidação preservadas com hashes SHA-256; Git mantém os bytes originais. [Origem e hashes](evidence/README.md). |
| Telemetria com acesso restrito | Exporter interno e ServiceAccount de observação com permissões de leitura no namespace. Ausência de métricas é indicada como indisponibilidade, sem criar valores zero. [Fontes e RBAC](control-room.md). |
| Histórico visual de elasticidade | Coleta limitada, lacunas explícitas, gráficos e downloads JSON/CSV verificados no navegador em Compose e Kubernetes, com viewports de 1440 e 390 px. [Registro](evidence/presentation-validation-2026-11-13.json). |

## Verificação consolidada de 13/11/2026

| Verificação | Resultado |
| --- | --- |
| `uv run pytest -q` | 177 testes aprovados; oito de integração não selecionados nessa rodada. Um aviso de depreciação Starlette/httpx. |
| `node --test tests/*.test.mjs` | 41 testes aprovados. |
| `& ./k8s/Test-Manifests.ps1` | Cinco perfis aprovados; inclui rede, PVC, HPA, imagens, concorrência, RBAC, NGINX e sintaxe PowerShell. Não substitui validação pelo servidor nem ensaio de execução. |
| `docker compose config --quiet` | Configuração aceita. |
| Preparação e prontidão | 12 verificações reais aprovadas nos modos de consulta e `-Start`. [Snapshot](evidence/readiness-validation-2026-11-13.json). |

Os resultados de integração, recuperação, desempenho e HPA pertencem às execuções datadas indicadas. A rodada final de testes unitários/estáticos não repetiu esses experimentos. As instruções reproduzíveis estão no [roteiro de execução](delivery-validation.md), no [ensaio de recuperação/escala](requirements-experiments.md) e no [guia da coleta](elasticity-presentation.md).

## Limites técnicos

- API com uma réplica e SQLite local; não escalar a API usando arquivos de banco independentes.
- RabbitMQ com uma instância e cluster local de um nó. Persistência e reposição de Pod não comprovam tolerância à perda do nó.
- Medições de desempenho locais, com recursos e concorrência documentados; ganho não universal nem necessariamente linear.
- O perfil de cem batalhas usa HPA fixo 5/5 e vinte slots por worker. O ensaio HPA 1–5 usa um slot por worker; os tempos desses perfis não são diretamente comparáveis.
- Contagem de concluídas é global, fontes de métricas possuem horários distintos e os gráficos não provam causalidade do HPA isoladamente. Consulte limites e condições do controlador para atribuir as mudanças observadas.
