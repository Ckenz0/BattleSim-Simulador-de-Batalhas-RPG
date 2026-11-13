# Roteiro de apresentação do BattleSim

Distribuição **sugerida para o ensaio** entre Cauê, Bruno e Rafael. Reservem cerca de **20 a 25 minutos**, além da preparação anterior à demonstração. A redução automática do HPA leva vários minutos e pode variar.

## Preparar antes de começar

Na raiz do repositório, execute:

```powershell
& ./scripts/Prepare-Presentation.ps1 -Start
```

Todos os itens precisam indicar `PASS`. O comando inicia os ambientes existentes e reabre o Ingress; não cria o cluster, não troca o perfil HPA e não apaga dados. Se houver `FAIL`, siga a ação indicada. O relatório fica em `.git/presentation-readiness.json`. Para conferir novamente sem iniciar serviços, execute o mesmo comando sem `-Start`.

O perfil esperado é `docker-desktop-hpa`, com HPA 1–5, um worker inicial, concorrência 1 e trabalho CPU 5.000.000. Se outro perfil estiver ativo, use a [seleção de perfil](delivery-validation.md#selecionar-o-perfil-de-elasticidade) antes da apresentação, com a fila drenada.

Deixe duas abas identificadas:

- **Compose:** `http://localhost:8080`, para interrupção e recuperação do consumidor.
- **Kubernetes:** `http://localhost:8081/#control`, para Pods, escala e coleta do HPA.

Mantenha pelo menos dois personagens disponíveis em cada ambiente. As bases são separadas. Abra os terminais na raiz do repositório e deixe [resultados de recuperação e escala](requirements-results.md), [evidências do HPA](delivery-validation.md#resultados-observados-em-13112026) e [guia da coleta](elasticity-presentation.md) disponíveis. Os ensaios criam registros reais; não façam limpeza de volumes para preparar a aula.

## Ordem das falas e demonstrações

| Tempo aproximado | Integrante | O que explicar | O que mostrar |
| --- | --- | --- | --- |
| 0–3 min | Cauê | Arquitetura, responsabilidades e fluxo assíncrono | Diagrama do README, quatro componentes e uma batalha |
| 3–6 min | Bruno | Consumidor parado, fila e recuperação | Compose: aceitar dez batalhas com worker parado e retomar os mesmos pedidos |
| 6–10 min | Rafael | Escala manual e reposição automática de Pod | Kubernetes: dois workers, novo Pod substituindo o removido; depois restaurar a linha de base |
| 10–12 min | Rafael | Começar o ensaio de elasticidade | Coleta no navegador e gerador de carga no terminal |
| 12–15 min | Cauê | Correlação, outbox, confirmações e idempotência | Percurso de uma batalha já concluída no Compose; a coleta Kubernetes permanece visível |
| 15–18 min | Bruno | Comparação de escala e limites dos números | Resultados históricos 1/3/5, sem mudar a configuração do ensaio ativo |
| 18–22 min | Rafael e grupo | Drenagem, redução automática e conclusão | Gráficos, fila vazia, retorno a uma réplica e exportação |

São janelas para ensaio, não prazos garantidos. Se a reposição ou o HPA demorar mais, ajustem a fala e preservem a distinção entre resultado observado e esperado.

## Cauê — arquitetura e uma batalha

Fala de abertura sugerida:

> “O BattleSim usa batalhas RPG para demonstrar uma aplicação distribuída. O navegador entra pelo NGINX. O Serviço A valida e grava o pedido; o RabbitMQ transporta as mensagens; o Serviço B executa a simulação e publica o resultado. A API persiste esse resultado e a interface o consulta.”

Mostre `docker compose ps`: há quatro tipos de serviço e apenas NGINX publica a porta. API e worker não fazem chamadas HTTP diretas entre si no fluxo da batalha. A API mantém SQLite e uma outbox transacional; o worker não acessa o banco.

Na Arena do Compose, selecione dois personagens e inicie uma batalha. Abra seu **Percurso** pelo histórico. Identifique `battle_id`, `request_id`, publicação e processamento. A animação representa o resultado calculado; sua duração não é a duração do trabalho no worker.

Passagem: “Agora vamos interromper o consumidor e observar por que a aceitação do pedido não depende de executar a batalha imediatamente.”

## Bruno — falha e recuperação no Compose

Confira que não há outra carga em execução. Pare somente o worker:

```powershell
docker compose stop service-b
```

Em **Teste de carga** no Compose, escolha **10 batalhas**, envie uma única vez e guarde a identificação do lote. Abra a Sala de Controle do Compose: mostre pedidos pendentes, mensagens prontas e ausência do consumidor da fila de pedidos. A API continua aceitando e persistindo pedidos; `202 Accepted` não significa “batalha concluída”.

Retome o mesmo consumidor:

```powershell
docker compose start service-b
```

Acompanhe o mesmo lote até os estados terminais, sem reenviar a solicitação. Confira IDs, resultados e a fila drenada. Se houver uma falha de batalha, mostre o resultado real e investigue; não anuncie sucesso antes da leitura.

Explique que a fila é durável e as mensagens são persistentes. O worker confirma a tarefa depois de publicar o resultado, e a API confirma o evento depois de persistir. Uma reentrega pode repetir trabalho, por isso o armazenamento também trata duplicação e mantém um único resultado aceito.

Recuperação obrigatória se a demonstração for interrompida: execute `docker compose start service-b` antes de seguir.

## Rafael — escala manual e reposição no Kubernetes

Esta etapa acontece **antes** da coleta HPA. Confira `/api/stats` no Kubernetes: `pending`, `processing` e `unpublished` devem estar zerados. Suspender temporariamente o HPA evita que ele dispute a escala manual:

```powershell
kubectl --context docker-desktop -n battlesim delete hpa service-b --ignore-not-found
kubectl --context docker-desktop -n battlesim scale deployment/service-b --replicas=2
kubectl --context docker-desktop -n battlesim rollout status deployment/service-b --timeout=180s
kubectl --context docker-desktop -n battlesim get pods -l app=service-b -o wide
```

Mostre duas réplicas prontas. Se houver tempo, envie dez batalhas no Kubernetes e confira a distribuição nos resultados do lote; espere a fila drenar antes da próxima ação. Capacidade configurada não prova ocupação simultânea de todos os slots.

Registre os UIDs e remova **um** Pod com encerramento normal:

```powershell
$before = kubectl --context docker-desktop -n battlesim get pods -l app=service-b -o json | ConvertFrom-Json
$before.items | Select-Object @{Name='Pod';Expression={$_.metadata.name}}, @{Name='UID';Expression={$_.metadata.uid}}
$targetPod = $before.items | Where-Object { -not $_.metadata.deletionTimestamp } | Select-Object -First 1
kubectl --context docker-desktop -n battlesim delete pod $targetPod.metadata.name
kubectl --context docker-desktop -n battlesim rollout status deployment/service-b --timeout=180s
kubectl --context docker-desktop -n battlesim get pods -l app=service-b -o custom-columns=NAME:.metadata.name,UID:.metadata.uid,PHASE:.status.phase
```

O Deployment deve repor o Pod e voltar a duas réplicas prontas, com um UID novo. Isso é **reposição**, mantendo a quantidade desejada; ainda não é elasticidade. Não use `--force`.

Com a fila drenada, restaure a linha de base e o HPA:

```powershell
kubectl --context docker-desktop -n battlesim scale deployment/service-b --replicas=1
kubectl --context docker-desktop apply -k k8s/overlays/docker-desktop-hpa
kubectl --context docker-desktop -n battlesim rollout status deployment/service-b --timeout=180s
& ./scripts/Prepare-Presentation.ps1
```

Prossiga quando a checagem passar. Se a etapa for interrompida após remover o HPA, reaplique esse overlay antes de encerrar a apresentação.

## Rafael — iniciar a coleta e a carga HPA

No Kubernetes, abra a Sala de Controle, confirme **HPA variável · 1 a 5 workers**, clique em **Iniciar coleta** e aguarde a primeira leitura. Gere carga em outro terminal:

```powershell
& ./k8s/Invoke-Load.ps1 -BaseUrl http://localhost:8081 -DurationSeconds 120 -TargetBacklog 30 -BatchSize 15
```

Mantenha a sala visível. Compare CPU com a meta de 60% do request, réplicas atuais/desejadas e fila. A CPU extra é trabalho real PBKDF2. CPU de 100% no gráfico equivale ao request de 250m, não a 100% da máquina inteira.

Durante essa coleta, não mude perfil, carga CPU, requests, limites ou número de réplicas. O perfil fixo 5/5 de cem batalhas não demonstra subida/descida automática.

## Cauê — explicar garantias enquanto o HPA é observado

Use a aba Compose para consultar o percurso da batalha já concluída. Deixe a aba Kubernetes **visível em outra janela ou tela**, sem minimizar ou trocar sua aba ativa; ocultá-la pausa a coleta. Se houver apenas uma tela, mantenha o gráfico visível e explique usando os identificadores anotados, sem navegar para outra visão.

Explique:

- A outbox preserva a intenção de publicação na mesma transação da aceitação do pedido.
- Publisher confirm é a confirmação do broker, não o resultado da batalha.
- Uma tarefa sem ACK pode ser entregue novamente; idempotência evita duplicar o resultado e recompensas.
- O percurso registra o que a API observou. Horários das fontes podem diferir; registros ausentes não são etapas inventadas.

## Bruno — escala medida e limites

Apresente os resultados como **medições históricas de 09/11/2026**, consultando [o relatório](requirements-results.md). Foram três rodadas de cem batalhas para cada cenário, mesma configuração de CPU/concorrência entre cenários e aquecimento excluído:

| Workers fixos | Mediana do tempo do lote |
| --- | --- |
| 1 | 84,67 s |
| 3 | 28,69 s |
| 5 | 18,56 s |

“Nesse ambiente, cinco workers concluíram o lote 4,56 vezes mais rápido que um. O limite total de CPU disponível aos workers também cresceu. Esses números não são previsão universal para produção.”

O comparativo controlado usa concorrência 20 por worker e CPU extra 5M. O ensaio HPA ativo usa concorrência 1 e CPU extra 5M. Não compare diretamente os tempos dos dois como se fossem o mesmo experimento.

Explique também os limites: API com uma réplica e SQLite local; RabbitMQ com uma instância; cluster local de um nó. PVC e reposição de Pod não comprovam alta disponibilidade diante da perda do nó.

## Grupo — redução, exportação e encerramento

Após o gerador parar, mostre a fila/outbox drenadas e aguarde a redução automática. A janela de estabilização é de 120 segundos, seguida de redução de até um Pod por minuto. Não reduza réplicas manualmente para acelerar esta demonstração.

Ao observar o retorno a uma réplica, clique em **Encerrar coleta** e exporte JSON e CSV. A variação de concluídas é global e pode incluir outros pedidos; o request ID do gerador identifica a carga específica. Gráficos mostram observações amostradas, não todas as decisões internas do controlador.

Se o retorno não ocorrer no tempo disponível, exporte o trecho observado e declare a coleta parcial. Use as [amostras históricas](evidence/README.md) para explicar o ciclo completo anterior, identificando-as como históricas. Não substitua silenciosamente uma demonstração atual por dados anteriores.

Fechamento sugerido:

> “Mostramos entrada única pelo NGINX, processamento por mensagens, aceitação com consumidor parado, recuperação, reposição de Pod e escala dos workers. A escala manual altera a capacidade desejada por uma ação nossa; a elasticidade ajusta essa capacidade pelo HPA. As evidências distinguem observação atual, ensaio histórico e limites do ambiente.”

## Se algo não estiver pronto

| Sinal | Ação |
| --- | --- |
| Docker ou Compose indisponível | Rode `Prepare-Presentation.ps1 -Start` antes do experimento e siga a ação do item que falhou. |
| Porta 8081 não responde | Reabra com `k8s/Start-LocalIngress.ps1`; verifique conflito de porta e prontidão do controller. |
| Métricas indisponíveis | Aguarde Metrics Server e confira `kubectl ... top pods`. Ausência não é CPU zero. |
| HPA fixo ou CPU extra zero | Antes da coleta, selecione o perfil HPA conforme `delivery-validation.md`. |
| Fila não drena | Confira consumidores, logs e conexão ao broker. Não reinicie ou apague volumes para produzir um estado vazio. |
| Coleta pausada | Volte à sala e mantenha a janela visível; a lacuna fica registrada. |
| Pod não repõe ou workloads não ficam Ready | Mostre o estado real e investigue `get pods`, `describe` e eventos; não prometa recuperação sem observá-la. |

Evitem executar os testes de integração ou comparativos automatizados enquanto a demonstração manual/HPA estiver ativa, pois eles interrompem componentes ou alteram a carga/configuração.
