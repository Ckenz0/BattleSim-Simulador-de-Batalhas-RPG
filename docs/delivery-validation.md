# Validação da entrega e demonstração de elasticidade

Execute na raiz do repositório, no ambiente local Docker Desktop já implantado. O [setup completo](../k8s/local-setup.md) cobre a primeira implantação. Este roteiro preserva os volumes e o Secret existentes; os testes e a carga criam registros de demonstração.

## Inicializar e verificar os ambientes

Para executar a preparação e as verificações principais em um comando no cluster já implantado:

```powershell
& ./scripts/Prepare-Presentation.ps1 -Start
```

Sem `-Start`, o script apenas consulta o estado. O código de saída é 0 quando todos os itens passam e 1 quando há pendência; cada falha indica a recuperação. `-TimeoutSeconds` limita a espera de inicialização (padrão 180 s), e `-ReportPath` permite escolher outro destino para o JSON; por padrão ele fica em `.git/presentation-readiness.json`. O script não troca overlays/HPA, não cria credenciais e não remove volumes. Use o [roteiro do grupo](presentation-script.md) para organizar a demonstração. A sequência manual equivalente continua abaixo.

A porta Compose é descoberta pela publicação do NGINX, respeitando `APP_PORT`; a porta do Ingress local permanece 8081. A coleta final também tem timeouts por comando/HTTP, separados do orçamento de inicialização. O JSON lista os endereços efetivamente verificados.

Na validação de 13/11/2026, os modos de consulta e `-Start` passaram nas 12 verificações reais, preservando os ambientes existentes. O [snapshot versionado](evidence/readiness-validation-2026-11-13.json) registra a última execução; o estado futuro precisa ser consultado novamente. O script possui 25 testes de diagnóstico/orquestração, incluindo ferramentas ausentes, timeout, argumentos com espaços/aspas, porta alternativa, métricas ausentes, HPA fixo e Deployments indisponíveis. A suíte completa passou em **177 testes Python** e **41 JavaScript**, além dos cinco perfis estáticos. O início com engine parado foi simulado nos testes; as execuções reais de `-Start` encontraram o Docker já ativo. Os oito testes de integração Compose não foram repetidos nesta etapa; seus resultados anteriores estão separados abaixo.

```powershell
docker desktop start --timeout 180
docker info --format '{{.ServerVersion}}'
docker compose up --build -d --wait --wait-timeout 180
docker compose ps
docker compose exec -T nginx nginx -t
kubectl --context docker-desktop get nodes
kubectl --context docker-desktop -n battlesim rollout status statefulset/rabbitmq --timeout=180s
kubectl --context docker-desktop -n battlesim rollout status deployment/service-a --timeout=180s
kubectl --context docker-desktop -n battlesim rollout status deployment/frontend --timeout=180s
kubectl --context docker-desktop wait --for=condition=Available apiservice/v1beta1.metrics.k8s.io --timeout=180s
& ./k8s/Start-LocalIngress.ps1
Invoke-RestMethod http://127.0.0.1:8080/api/health/ready
Invoke-RestMethod http://localhost:8081/api/health/ready
kubectl --context docker-desktop -n battlesim top pods
```

As duas APIs devem responder com `status=ok`, banco disponível e broker conectado. O Metrics Server precisa retornar CPU/memória. Após iniciar o Desktop, os serviços de DNS e métricas podem levar alguns instantes para recuperar; aguarde prontidão antes de gerar carga.

Com o Compose disponível, execute os oito testes reais de integração. Eles interrompem/reiniciam o worker e o broker do Compose e restauram uma réplica do worker; execute sem outra demonstração concorrente nesse ambiente:

```powershell
uv run pytest -m integration -v
```

## Selecionar o perfil de elasticidade

Para observar elasticidade por CPU, use `docker-desktop-hpa`: `minReplicas=1`, `maxReplicas=5`, concorrência/prefetch 1 e `WORKER_CPU_ITERATIONS=5000000`. O perfil `docker-desktop-concurrent100` mantém cinco workers fixos e serve para demonstrar capacidade concorrente.

Confira que não há tarefas pendentes, em processamento ou aguardando publicação antes de trocar o perfil:

```powershell
Invoke-RestMethod http://localhost:8081/api/stats
```

Com a fila drenada, prepare a linha de base. A remoção temporária somente do HPA permite reduzir manualmente a uma réplica antes do experimento; a medição começa depois de recriá-lo:

```powershell
kubectl --context docker-desktop apply --dry-run=server -k k8s/overlays/docker-desktop-hpa
kubectl --context docker-desktop -n battlesim delete hpa service-b --ignore-not-found
kubectl --context docker-desktop -n battlesim scale deployment/service-b --replicas=1
kubectl --context docker-desktop apply -k k8s/overlays/docker-desktop-hpa
kubectl --context docker-desktop -n battlesim rollout status deployment/service-a --timeout=180s
kubectl --context docker-desktop -n battlesim rollout status deployment/service-b --timeout=180s
kubectl --context docker-desktop -n battlesim get hpa service-b
kubectl --context docker-desktop -n battlesim logs deployment/service-b --tail=10
kubectl --context docker-desktop -n battlesim top pods
```

Confirme nos logs `cpu_iterations=5000000` e `concurrency=1`, e no HPA os limites 1/5 e métrica CPU válida. A aplicação continua em **http://localhost:8081**.

## Demonstrar subida e descida automáticas

Em outro terminal, acompanhe réplicas e métricas:

```powershell
kubectl --context docker-desktop -n battlesim get hpa service-b -w
```

Inicie a carga pelo mesmo ponto de entrada usado pelo navegador:

```powershell
& ./k8s/Invoke-Load.ps1 -BaseUrl http://localhost:8081 -DurationSeconds 120 -TargetBacklog 30 -BatchSize 15
```

Registre horários, CPU, réplicas atuais/desejadas e o request ID do gerador. Depois da carga, acompanhe `/api/stats` até `pending=processing=unpublished=0` e aguarde o retorno automático a uma réplica. Durante a medição, mantenha HPA, recursos, carga CPU e escala manual inalterados. A janela de estabilização é de 120 segundos e a redução remove até um Pod por minuto; reserve vários minutos para observá-la.

As [evidências versionadas](evidence/README.md) incluem as amostras brutas do ensaio original e os demais experimentos. A [certificação técnica](technical-certification.md) identifica os comportamentos verificados, as evidências e seus limites.

## Resultados observados em 13/11/2026

O Docker Desktop estava parado. Após sua inicialização, os serviços do cluster recuperaram DNS, broker e métricas; as falhas transitórias de inicialização do frontend cessaram. O Compose foi iniciado com build e espera de prontidão. Os volumes existentes foram preservados.

| Verificação | Resultado |
| --- | --- |
| Compose | Quatro serviços em execução; somente NGINX publica porta no host. API disponível em `http://127.0.0.1:8080`. |
| Integração real | **8 testes aprovados**, incluindo parada do consumidor, reinício/indisponibilidade do broker, persistência e escala de workers. |
| Kubernetes | Nó Ready, API disponível pelo Ingress em `http://localhost:8081`, PVCs Bound com os mesmos volumes e métricas disponíveis. |
| Configuração | `nginx -t` aprovado no Compose e no Kubernetes; dry-run do perfil HPA pelo servidor e cinco perfis estáticos aprovados. |
| Perfil final | `docker-desktop-hpa`, CPU extra 5.000.000, concorrência 1, HPA de 1 a 5, uma réplica ao final. |
| Carga HPA | 637 batalhas aceitas e concluídas, zero falhas, 637 IDs únicos e cinco workers distintos. |
| Estado final | Pendentes, em processamento e outbox não publicada zerados. |

Réplicas atuais observadas, com aproximadamente 15 segundos entre amostras. O tempo começa no observador, antes de iniciar o gerador:

| Tempo (s) | Réplicas atuais |
| --- | --- |
| 0 | 1 |
| 76 | 3 |
| 106 | 5 |
| 288 | 4 |
| 349 | 3 |
| 409 | 2 |
| 470 | 1 |

O HPA ajustou as réplicas sem intervenção manual durante a medição. A primeira amostra com fila/outbox vazias ocorreu aos 152 segundos; o pico medido foi 398% do request de CPU. O perfil de HPA foi mantido após o ensaio para a próxima demonstração. Os dados completos estão nas [32 amostras brutas](evidence/hpa-evidence-2026-11-13.json) e no [registro da validação](evidence/delivery-validation-2026-11-13.json).

Os testes e a carga adicionaram registros de demonstração; os dados anteriores e os volumes foram mantidos. A execução do HPA foi única e não deve ser interpretada como benchmark de desempenho.
