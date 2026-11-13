# Roteiro de demonstração da primeira etapa

Execute na raiz do repositório com .env configurado e Docker em funcionamento.

## 1. Subir e identificar os componentes

```bash
docker compose up --build -d
docker compose ps
docker compose exec nginx nginx -t
```

Há quatro containers principais e apenas NGINX publica porta. Abra localhost:8080. Crie Lyra (Mago), Kael (Guerreiro) e opcionalmente Sylve (Arqueiro) pela interface.

## 2. Rastrear uma batalha

Abra outro terminal com:

```bash
docker compose logs -f nginx service-a service-b
```

Selecione os combatentes e inicie uma batalha. No navegador, a resposta POST /api/battles é 202 e inclui id e request_id. Relacione o request_id ao acesso NGINX, battle_accepted e battle_published; acompanhe battle_processing/battle_finished com battle_id e worker_id. Abra o resultado e expanda o histórico dos ataques.

## 3. Interromper o consumidor

```bash
docker compose stop service-b
```

Solicite dez batalhas em Teste de carga. Elas são aceitas e permanecem pending. Inspecione a fila sem publicar a administração do broker:

```bash
docker compose exec rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers
```

A fila de pedidos deve apresentar pendências e nenhum consumidor. Retome:

```bash
docker compose up -d service-b
```

A quantidade de pendentes cai e as concluídas aumentam. O broker guardou tarefas persistentes; não foi o frontend que as reenviou.

## 4. Persistência do broker e outbox

Com o worker parado, enfileire tarefas, aguarde a indicação de que os pedidos foram enviados e reinicie RabbitMQ. Após ficar saudável, retome o worker; os pedidos persistidos devem terminar.

Para observar a outbox:

```bash
docker compose stop rabbitmq
```

Solicite novas batalhas. O HTTP permanece disponível; o painel mostra processamento indisponível e tarefas aguardando envio. Retome:

```bash
docker compose start rabbitmq
```

A API reconecta, publica as tarefas salvas e consome os resultados. Uma confirmação de HTTP 202 significou gravação local; não indicou execução imediata.

## 5. Distribuir tarefas

Altere WORKER_CPU_ITERATIONS para 500000 ou 1000000 no .env. Então:

```bash
docker compose up -d --force-recreate --scale service-b=3 service-b
```

Espere os três workers aparecerem em worker_ready nos logs. Solicite 100 batalhas. Observe worker_id diferentes em Teste de carga e nos logs. Compare a evolução da fila com uma única réplica, usando a mesma carga CPU.

```bash
docker compose up -d --scale service-b=1 service-b
```

Os contadores são cumulativos, inclusive para workers já removidos; compare o incremento dos contadores e os novos logs para identificar a execução atual.

## 6. Executar a verificação automatizada

```bash
uv run pytest -q
uv run pytest -m integration -v
```

A integração altera o estado do ambiente local, cria registros de teste e restaura uma réplica do worker no final. Não execute simultaneamente com a demonstração manual.

## Demonstrações complementares

O Compose demonstra containers, fila, recuperação e distribuição. A implantação Kubernetes e o HPA já foram executados; veja o [roteiro local](../k8s/local-setup.md) e as [evidências](kubernetes-validation.md). Para verificar recuperação sob carga e efeito da quantidade de réplicas, use o [ensaio de falha durante100 batalhas e comparação1/3/5workers](requirements-experiments.md). Ele complementa o perfil de100 tarefas concorrentes e preserva o teste separado de elasticidade automática.
