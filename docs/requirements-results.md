# Recuperação e desempenho — resultados de 9 de novembro de 2026

Ensaios reais no cluster local Docker Desktop/kind, Kubernetes 1.36.1, um nó. Aplicação medida a partir da revisão `4ab055d`, worker `battlesim-worker:concurrent100-v1`. Recursos Docker disponíveis: 12 CPUs e aproximadamente 15,2 GiB; cada worker foi limitado a 1 CPU/256 Mi, com request 250m/128 Mi e 20 slots.

O [roteiro reproduzível](requirements-experiments.md) descreve os comandos e critérios. Os [dados estruturados](evidence/requirements-results.json) contêm os IDs, amostras por batalha, contadores de CPU, tentativas e resumos para conferência independente, sem credenciais.

## Falha com 100 batalhas em andamento

- Lote: `cc8978af-ed09-488e-a7eb-4cdc24067f42`.
- Pod removido: `service-b-b8c647cfd-2hjdk`, UID `d19fb804-e561-4d4f-861d-b0d87a7afe0c`.
- O worker tinha **20 tentativas ativas** desse lote; remoção com grace de 5 s, sem force.
- Substituto: `service-b-b8c647cfd-lkrnm`, UID `831f3396-bc2e-4fa0-b975-773377a53c99`.
- **20 batalhas tiveram novo attempt_id**, comprovando reentrega e reexecução.
- **100 IDs originais concluídos, zero falhas, zero IDs faltantes/extras/duplicados** no resultado persistido.
- Do registro da aceitação até a verificação final da recuperação: aproximadamente **46.2 segundos**; esse valor inclui consultas de conferência.

API, RabbitMQ, Secrets e volumes permaneceram. A aplicação não precisou reenviar as tarefas pelo navegador. Tentativas físicas repetidas são esperadas na entrega ao menos uma vez; o histórico conserva um resultado por battle_id. Este teste usou duelos livres, sem concessão de XP. A idempotência das recompensas da Aventura tem testes próprios.

## Comparação controlada de 1, 3 e 5 workers

Cada cenário recebeu três lotes medidos de 100 batalhas, com os mesmos personagens, 20 slots por worker e **5.000.000 iterações PBKDF2** por batalha. Aquecimentos de 20/60/100 tarefas foram excluídos. Não houve execução paralela entre cenários. Réplicas ficaram fixas em cada cenário; não é uma medição de elasticidade automática.

Valores abaixo são medianas das três rodadas. CPU média aproxima o total de núcleos utilizados pelos workers, não a quantidade de threads nem a porcentagem da máquina inteira.

| Workers | Slots disponíveis | Tempo total (s) | Batalhas/s | CPU média (núcleos) | Ganho vs 1 | Eficiência relativa |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 20 | 84.67 | 1.18 | 0.99 | 1.00× | 100.0% |
| 3 | 60 | 28.69 | 3.49 | 2.74 | 2.95× | 98.4% |
| 5 | 100 | 18.56 | 5.39 | 4.51 | 4.56× | 91.2% |

Com cinco workers, o lote foi concluído **4,56 vezes mais rápido** que com um. O limite total disponível de CPU dos workers também cresceu de 1 para 5 núcleos. A melhora não decorre de 100 threads criarem 100 núcleos. API, publicação, coleta, contenção e variações do processador impedem assumir aceleração perfeitamente linear.

## Latência e espera

As colunas são medianas das estatísticas por rodada. p95 usa a posição ceil(0,95×100), sem interpolação. Espera até o worker inclui outbox, transporte e admissão, não apenas a fila RabbitMQ. Os logs cobriram 100/100 IDs em todas as nove medições.

| Workers | p95 registro → resultado (s) | Espera média até worker (s) | p95 espera até worker (s) | p95 processamento (s) |
| --- | --- | --- | --- | --- |
| 1 | 83.32 | 33.04 | 71.28 | 25.71 |
| 3 | 27.06 | 5.55 | 17.48 | 23.49 |
| 5 | 16.83 | 1.29 | 2.33 | 15.22 |

## Rodadas individuais

| Workers | Rodada | Tempo (s) | Batalhas/s | Lote |
| --- | --- | --- | --- | --- |
| 1 | 1 | 85.44 | 1.17 | `a3126016-a981-4bbc-8203-5f3a8e7ac752` |
| 1 | 2 | 80.53 | 1.24 | `7bace602-57e7-454f-912b-1234166e5321` |
| 1 | 3 | 84.67 | 1.18 | `b73d9b8d-05ba-484a-938d-f6dce6645046` |
| 3 | 1 | 28.66 | 3.49 | `df0eb0b2-3b07-4757-a419-8b72bd167d81` |
| 3 | 2 | 28.69 | 3.49 | `5d743294-bec9-455a-b987-cd7fb8a65860` |
| 3 | 3 | 28.88 | 3.46 | `a823bdd4-dc4d-4222-9f6b-629f88afb8e3` |
| 5 | 1 | 18.56 | 5.39 | `58e0a37b-82d3-4f1b-92be-3179c8683810` |
| 5 | 2 | 17.55 | 5.70 | `ec4ffacd-1e89-42d4-83b4-6cacfdaa5e5f` |
| 5 | 3 | 18.64 | 5.36 | `2324cf0a-427e-4398-9576-66419f7ee514` |

## Validade e limites da coleta

- Cada medição preservou o conjunto de 100 IDs, com 100 resultados completos e sem reinício/troca de Pod ou container durante a rodada.
- Recursos iniciais e identidade das imagens foram registrados; observações independentes durante os cenários 1/3/5 confirmaram os mesmos limites, concorrência 20 e CPU extra 5M. A versão final da ferramenta também valida e salva esses controles antes/depois de cada rodada.
- CPU foi medida por deltas de usage_usec do cgroup. As leituras envolvem o intervalo do lote, com pequeno overhead de diagnóstico, portanto a razão CPU/tempo é aproximada. Não foram usadas amostras do Metrics Server neste comparativo.
- Há três repetições locais e ordem fixa 1 → 3 → 5; carga de fundo, aquecimento e frequência do processador podem afetar os números. Não é um resultado universal nem previsão para produção.
- A API registra timestamps e o worker registra o início com o relógio UTC do mesmo host local. Espera por fase em hosts com relógios diferentes exigiria sincronização e tratamento de desvio.
- A evidência do lote de falha foi conferida novamente após o comparativo, sem reenviar trabalho. O JSON público preserva os resultados e a distinção entre observações durante a execução e auditoria posterior. Hashes do coletor executado acompanham os dados; reforços posteriores de validação foram testados separadamente.
- O ensaio gerou 1180 batalhas únicas: 100 da falha, 900 medidas e 180 de aquecimento. As 20 reexecuções do worker removido não criaram novas batalhas no histórico.

## Estado final e requisitos atendidos

A restauração automática foi confirmada: cinco workers Ready, 20 slots cada, CPU extra 10M herdada do perfil 100, HPA 5/5, fila/outbox sem pendências e API disponível. O jogo permaneceu em `http://localhost:8081`. O Compose continuou separado e seus dados não foram apagados.

Este ensaio reforça recuperação do consumidor, persistência dos pedidos, reposição de Pod e escalabilidade horizontal. A prova de **elasticidade automática 1 → 5 → 1** continua em [kubernetes-validation.md](kubernetes-validation.md), usando o perfil próprio de HPA.
