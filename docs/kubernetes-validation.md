# Validação Kubernetes — 8 de novembro de 2026

Execução real no Docker Desktop desta máquina, com contexto `docker-desktop`. O procedimento reproduzível está em [k8s/local-setup.md](../k8s/local-setup.md). Estes resultados complementam o roteiro genérico de [Kubernetes e HPA](../k8s/README.md).

## Ambiente

| Item | Configuração observada |
| --- | --- |
| Cluster | kind integrado ao Docker Desktop, um nó `desktop-control-plane` Ready |
| Kubernetes / runtime | 1.36.1 / containerd 2.3.1 |
| Docker disponível | 12 CPUs, aproximadamente 15,2 GiB de memória |
| StorageClass | `standard`, provisioner `rancher.io/local-path`, WaitForFirstConsumer |
| Volumes | SQLite `api-data` e RabbitMQ `data-rabbitmq-0`, ambos Bound de 1 GiB |
| Ingress | F5 NGINX OSS 5.7.1, classe `nginx`, host `localhost` |
| Métricas | Metrics Server 0.9.1, API de métricas Available, `kubectl top pods` funcional |
| Acesso | http://localhost:8081, port-forward do controller restrito a loopback IPv4/IPv6 |

O Compose continuou saudável em 8080, com dados separados. Nenhum volume ou Secret existente foi removido. As imagens locais da aplicação foram efetivamente executadas nos Pods. Não foi necessário instalar outro gerenciador de cluster ou publicar imagens em registry externo.

## Aplicação, persistência e reposição

- `/`, `/api/health/ready` e `/js/adventure.mjs` responderam HTTP 200 através do controller. O módulo chegou como `application/javascript`.
- O `X-Request-ID` enviado foi preservado nas respostas e no processamento pelo worker.
- Um herói Mago foi criado com cinco pontos em ataque. A luta passou por API, outbox, RabbitMQ e worker; vitória abriu recompensa, e a melhoria levou o herói à fase 2, nível 2, ataque 65.
- O mesmo progresso permaneceu após a substituição do Pod da API causada pela mudança do ConfigMap do ensaio. SQLite persistiu no PVC.
- O Deployment worker foi escalado manualmente para duas réplicas. Um Pod foi removido sem force; o controlador criou outro, com nome/UID diferente, e restaurou o total desejado.
- Depois, três workers concluíram um lote de 60 batalhas da mesma fila. Os três identificadores apareceram nos resultados únicos registrados pela API.

O experimento de escala manual ocorreu com HPA removido. Ele foi recriado antes do ensaio automático; as duas operações não disputaram réplicas.

## HPA de CPU: subida e descida observadas

Parâmetros: `autoscaling/v2`, request de CPU `250m` por worker, limite `1` CPU, alvo de 60% do request, mínimo 1/máximo 5. A carga usa **5.000.000 de iterações PBKDF2-HMAC-SHA256 por batalha**, além do motor de combate. Não usa espera artificial.

O gerador rodou 120 segundos, com backlog-alvo 30 e lotes de até 15. Foram aceitas e concluídas **683 batalhas da carga**, sem falhas. Request ID: `hpa-54123e657cf54403af4efa420bec70d4`.

O pico amostrado pelo HPA foi **398% do request de CPU** (aproximadamente 995m por worker; não é percentual da máquina inteira). O HPA aumentou de uma para três e depois cinco réplicas. Após o encerramento da carga e a fila vazia, reduziu gradualmente até uma, sem comandos manuais de escala ou alteração do HPA durante a medição.

Horários UTC; a coluna de tempo começa na primeira amostra do observador, cerca de dez segundos depois do início do gerador:

| Horário UTC | Tempo observado | Réplicas atuais | Desejadas | Pendentes / em processamento |
| --- | --- | --- | --- | --- |
| 03:10:30 | 0 s | 1 | 1 | 26 / 1 |
| 03:11:01 | 30 s | 3 | 3 | 22 / 3 |
| 03:11:31 | 61 s | 5 | 5 | 19 / 4 |
| 03:15:03 | 273 s | 4 | 4 | 0 / 0 |
| 03:16:04 | 334 s | 3 | 3 | 0 / 0 |
| 03:17:05 | 394 s | 2 | 2 | 0 / 0 |
| 03:18:05 | 455 s | 1 | 1 | 0 / 0 |

A redução respeitou a janela de estabilização de 120 segundos e a política de remover no máximo um Pod a cada 60 segundos. Ao final, pendentes, em processamento e outbox não publicada estavam zerados. A API registrava 744 batalhas concluídas: 683 do HPA, 60 da escala manual e uma da aventura; zero falhas.

Houve avisos transitórios de métricas ausentes após o rollout inicial, antes das primeiras amostras dos novos Pods. Durante a medição, o HPA encontrou métricas válidas (`ScalingActive=True`, `ValidMetricFound`). `ScalingLimited` apareceu ao atingir limites de escala, como esperado pelas políticas configuradas.

Somente depois da volta automática a uma réplica foi reaplicado `k8s/overlays/docker-desktop`, restaurando `WORKER_CPU_ITERATIONS=0` e preservando PVCs, Secret e host local. O HPA permanece instalado para próximas demonstrações.

## Ajustes e limites verificados

- Metrics Server original não conseguiu validar o certificado do kubelet kind, sem IP SANs. O addon local usa a exceção `--kubelet-insecure-tls`, documentada exclusivamente para este ambiente. Produção exige certificados e CA válidos.
- O controller NGINX rejeitou uma regra sem host; o overlay local fixa `localhost`. O navegador usa esse nome em 8081, sem alteração do arquivo hosts.
- O script de acesso foi executado novamente sem criar outro forward. Uma porta ocupada por um listener alheio foi recusada sem encerrar seu processo. A revisão corrigiu a adoção ambígua de forwards de outro contexto.
- Addons e os dois overlays locais passaram em `kubectl apply --dry-run=server`; os guardrails de base/HPA, sintaxe PowerShell e whitespace passaram.
- API continua com uma réplica/Recreate e SQLite. RabbitMQ continua com um nó. Estes testes demonstram persistência local, reposição de Pod e elasticidade dos workers; não demonstram alta disponibilidade nem tolerância à perda do nó.

Amostras detalhadas, UIDs e logs operacionais ficam localmente em `.git/local-cluster/`, sem credenciais e fora do versionamento. Este documento registra o resumo verificável para a entrega acadêmica.
