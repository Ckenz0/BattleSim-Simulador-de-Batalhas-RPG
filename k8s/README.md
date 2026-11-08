# Kubernetes e HPA

Para o cluster integrado do Docker Desktop nesta máquina, veja o [procedimento local](local-setup.md), com versões fixadas dos addons, acesso em `http://localhost:8081` e overlays próprios. O roteiro genérico abaixo continua aplicável a outros clusters.

Esta implantação é independente do Compose: não importa seus volumes nem altera seus containers. Execute os comandos PowerShell na raiz do repositório. Os procedimentos abaixo são um roteiro genérico; os [resultados observados no cluster local](../docs/kubernetes-validation.md) registram a execução de 8 de novembro de 2026.

## Componentes e limites

| Recurso | Função | Persistência / escala |
| --- | --- | --- |
| `Deployment/service-a` + Service interno | API, SQLite, outbox e resultados | PVC `api-data` de 1 GiB, **uma réplica**, um processo Uvicorn, atualização `Recreate` |
| `Deployment/service-b` | Consumidores independentes, prefetch 1 | Sem DB/API/Service HTTP; HPA de 1 a 5 réplicas |
| `StatefulSet/rabbitmq` + Service headless interno | Broker AMQP e filas duráveis | Uma réplica, PVC `data-rabbitmq-0` de 1 GiB |
| `Deployment/frontend` + Service interno | Imagem NGINX com arquivos de `frontend/` e proxy `/api/` | Uma réplica |
| `Ingress/battlesim` | Encaminha `battlesim.local/` ao Service frontend | Requer NGINX Ingress Controller instalado |

API com SQLite e RabbitMQ de um nó **não são altamente disponíveis**. Recreate evita dois Pods escrevendo no SQLite durante atualizações normais; a API fica indisponível durante a troca. Não escale a API nem force substituição de um Pod enquanto seu nó antigo ainda puder escrever no volume. `ReadWriteOnce` não é uma trava exclusiva por Pod. Expansão futura exige banco apropriado e revisão de concorrência. RabbitMQ de um nó preserva dados no volume, mas indisponibilidade do nó interrompe processamento; persistência não substitui backup. Não aumente as réplicas do StatefulSet como se isso criasse um cluster RabbitMQ.

Todos os containers têm requests/limits. CPU do worker: request `250m`, limit `1`; alvo HPA `60%` significa aproximadamente **150m por Pod**, relativo ao request. Réplicas e recursos precisam caber nos nós. API usa `/api/health/live` e `/api/health/ready`; falha do broker tira a API de readiness sem reiniciá-la por liveness. RabbitMQ usa diagnósticos locais e frontend verifica os arquivos estáticos. Worker não oferece endpoint/heartbeat: não há probe HTTP fictícia ou teste de PID que se passe por saúde do consumidor. `Ready` desse Pod indica processo iniciado; confirme conexão em `worker_ready` e nos consumidores da fila. O processo reconecta com backoff e Kubernetes reinicia processos que saem; consumidor travado exige diagnóstico operacional.

Worker recebe SIGTERM e tem até 25 s para concluir trabalho; `terminationGracePeriodSeconds: 35` dá margem. API tem 35 s, RabbitMQ 60 s e NGINX 30 s com `SIGQUIT`. Mensagens não confirmadas voltam à fila; resultados são idempotentes no serviço A.

## Pré-requisitos

1. Cluster escolhido e contexto `kubectl` configurado, compatível com `autoscaling/v2` e `networking.k8s.io/v1`. Antes de qualquer escrita, confira `current-context` e `cluster-info`.
2. StorageClass padrão com provisionamento dinâmico e suporte a `fsGroup` para SQLite. A API executa como UID/GID 1000 e usa `fsGroup: 1000`. Se necessário, defina `storageClassName` nos dois pedidos de volume antes da criação; não mude volumes já utilizados às cegas.
3. Metrics Server funcional, fornecendo CPU via API de recursos. `kubectl top pods -n battlesim` deve retornar números após os Pods iniciarem. `unknown` no HPA não comprova elasticidade.
4. **NGINX Ingress Controller**, `IngressClass` chamada `nginx` e acesso ao endereço/porta do controller. Para instalação nova, use a variante NGINX Open Source do [NGINX Ingress Controller da F5](https://docs.nginx.com/nginx-ingress-controller/install/manifests/), conforme seu cluster. O projeto comunitário *ingress-nginx* foi [aposentado em março de 2026](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/); são produtos distintos. Este Ingress usa a API padrão, sem annotations específicas. Ajuste `ingressClassName` se a classe instalada tiver outro nome.

```powershell
kubectl config get-contexts
kubectl config current-context
kubectl cluster-info
kubectl get storageclass
kubectl get ingressclass
kubectl get apiservice v1beta1.metrics.k8s.io
```

Os manifests de `base/` pressupõem um cluster, um controller e Metrics Server já disponíveis. Para Docker Desktop, os addons em `addons/` e o [procedimento local](local-setup.md) preparam esses componentes. O Ingress não hospeda arquivos: a cadeia é **controller → Service frontend → Pod NGINX → Service API**. RabbitMQ e API não têm NodePort/LoadBalancer públicos. A demonstração usa HTTP local; para publicação externa, configure domínio e TLS.

## Construir e disponibilizar imagens

```powershell
docker build -f service-a/Dockerfile -t battlesim-api:local .
docker build -f service-b/Dockerfile -t battlesim-worker:local .
docker build -f k8s/frontend.Dockerfile -t battlesim-frontend:local .
```

O frontend inclui o conteúdo atual de `frontend/`; reconstrua após mudanças. Os Dockerfiles API/worker são os mesmos do Compose. `imagePullPolicy: IfNotPresent` permite imagens locais, mas o runtime **do cluster** deve enxergá-las. Docker Desktop pode usar armazenamento distinto do daemon Docker conforme a configuração. Confira o runtime; em outros clusters, carregue as imagens pelo mecanismo do cluster ou publique em seu registry e ajuste `images` em `k8s/base/kustomization.yaml`. Nenhuma publicação é feita aqui. Prefira tags novas por versão; se reutilizar `:local`, assegure que os nós receberam a imagem nova e reinicie o Deployment correspondente. Não remova PVCs para atualizar imagens.

NGINX preserva MIME `.mjs`, CSP, `nosniff`, política de referer e `X-Request-ID` sanitizado enviado à API e aos logs JSON. O Service `service-a` tem ClusterIP estável; NGINX resolve seu DNS ao iniciar. O resolver `127.0.0.11` do Compose não é usado. Se o **Service** API for apagado/recriado com outro IP, reinicie também o frontend. Reiniciar somente Pods API não muda o IP do Service.

## Segredo e implantação

Nenhuma senha real, padrão compartilhada ou Secret com dados entra no Git. `New-Secret.ps1` gera 32 bytes aleatórios, transforma em hexadecimal seguro para URL e envia username/password **por stdin** ao Kubernetes. Não grava arquivo nem imprime senha; não execute sob transcrição/debug que capture objetos locais. O Secret é referenciado por API, worker e broker; `RABBITMQ_URL` usa expansão de variáveis do Kubernetes na ordem declarada. Proteja acesso a Secrets; base64 não é criptografia.

```powershell
# Somente após conferir que este é o cluster desejado:
kubectl apply -f k8s/base/namespace.yaml
& ./k8s/New-Secret.ps1
kubectl apply --dry-run=server -k k8s
kubectl apply -k k8s
kubectl -n battlesim rollout status statefulset/rabbitmq --timeout=300s
kubectl -n battlesim rollout status deployment/service-a --timeout=180s
kubectl -n battlesim rollout status deployment/service-b --timeout=180s
kubectl -n battlesim rollout status deployment/frontend --timeout=180s
kubectl -n battlesim get pods,pvc,svc,ingress,hpa
```

Execute o gerador apenas na primeira implantação. Ele recusa sobrescrever o Secret: RabbitMQ só usa `RABBITMQ_DEFAULT_USER/PASS` na inicialização de um **volume novo**. Preserve o Secret junto do volume; trocar apenas o Secret quebra autenticação. Rotação posterior requer procedimento explícito no broker e consumidores. Kustomize não cria/remove esse Secret.

Associe `battlesim.local` ao IP publicado pelo controller no arquivo hosts/DNS, então abra `http://battlesim.local`. Para testar sem editar hosts, substitua o endereço abaixo pelo endpoint real:

```powershell
curl.exe -i -H 'Host: battlesim.local' http://ENDERECO-DO-CONTROLLER/
curl.exe -i -H 'Host: battlesim.local' -H 'X-Request-ID: k8s-trace-001' http://ENDERECO-DO-CONTROLLER/api/health/ready
kubectl -n battlesim logs deployment/frontend --tail=50
kubectl -n battlesim logs deployment/service-a --tail=50
```

Se o controller só estiver acessível via port-forward, descubra seu namespace/Service e encaminhe sua porta 80; mantenha o header Host. Para diagnosticar apenas a aplicação, outro terminal pode executar `kubectl -n battlesim port-forward service/frontend 8081:80`, abrindo `http://127.0.0.1:8081`. Isso não valida controller/Ingress.

## Reposição de Pod e escala manual

Observe `kubectl -n battlesim get pods -l app=service-b -w` em outro terminal. Remova temporariamente **somente o HPA** para a escala manual não disputar com ele; Deployments e volumes permanecem.

```powershell
kubectl -n battlesim delete hpa service-b
kubectl -n battlesim scale deployment/service-b --replicas=2
kubectl -n battlesim rollout status deployment/service-b --timeout=180s
kubectl -n battlesim get pods -l app=service-b -o wide
$victim = kubectl -n battlesim get pods -l app=service-b -o 'jsonpath={.items[0].metadata.name}'
kubectl -n battlesim get pod $victim -o 'jsonpath={.metadata.name}{" UID="}{.metadata.uid}{"\n"}'
kubectl -n battlesim delete pod $victim
kubectl -n battlesim get pods -l app=service-b -o wide
kubectl -n battlesim scale deployment/service-b --replicas=3
kubectl -n battlesim rollout status deployment/service-b --timeout=180s
```

Registre nomes/UIDs antes/depois, eventos do Deployment e volta ao total desejado. O substituto deve ter UID novo. Envie um lote pelo frontend ou `Invoke-Load.ps1` e confira `kubectl -n battlesim logs -l app=service-b --prefix --tail=100` e `GET /api/stats`: diferentes `worker_id` devem completar tarefas da mesma fila. Encerramento normal pode levar 35 s; não use `--force`. Reposição e mudança manual são experimentos distintos de HPA. Para voltar diretamente à base normal, use `kubectl apply -k k8s`.

## Ensaio reproduzível de HPA com CPU real

O overlay liga `WORKER_CPU_ITERATIONS=5000000`. Cada batalha executa PBKDF2-HMAC-SHA256 no worker, separado das regras determinísticas de combate; não é `sleep` nem carga na API. O valor válido é de 0 a 20 milhões e pode ser ajustado no generator do overlay conforme a máquina. A base usa `0` para o jogo normal.

```powershell
# Se o HPA estiver ativo, remova-o antes desta escala manual.
kubectl -n battlesim delete hpa service-b --ignore-not-found
kubectl -n battlesim scale deployment/service-b --replicas=1
kubectl apply -k k8s/overlays/hpa-demo
kubectl -n battlesim rollout status deployment/service-a --timeout=180s
kubectl -n battlesim rollout status deployment/service-b --timeout=180s
kubectl -n battlesim logs -l app=service-b --tail=30
kubectl -n battlesim top pods -l app=service-b
kubectl -n battlesim get hpa service-b
```

Confirme `worker_ready` com `cpu_iterations: 5000000` e uma réplica ociosa antes da carga. ConfigMaps com hash provocam rollout quando o valor muda; API e worker compartilham o ConfigMap, então aplicar/restaurar o overlay também reinicia a API com Recreate. Aguarde sua readiness antes de iniciar a carga. Em terminais separados, observe:

```powershell
kubectl -n battlesim get hpa service-b -w
kubectl -n battlesim get pods -l app=service-b -w
# Repita para amostrar CPU e investigar decisões:
kubectl -n battlesim top pods -l app=service-b
kubectl -n battlesim describe hpa service-b
```

Com o port-forward do frontend na porta 8081 ativo:

```powershell
& ./k8s/Invoke-Load.ps1 -BaseUrl http://127.0.0.1:8081 -DurationSeconds 600
# Ou -BaseUrl http://battlesim.local com Ingress/DNS já validados.
```

O script cria dois personagens de teste, envia lotes de até 25 pela **API pública** durante 10 minutos e mantém cerca de 50 batalhas pendentes/em processamento via `/api/stats`. A cada 2 s repõe apenas o que falta, evitando fila ilimitada. Usa o mesmo `request_id` rastreável e imprime `batch_id`, quantidade e backlog. Rode uma execução por vez em ambiente sem outros produtores. Registros persistem; não há exclusão de personagens, batalhas ou volumes. Ctrl+C encerra novas submissões, mas tarefas aceitas continuam. Timeout em POST não é repetido automaticamente, pois ele pode ter sido aceito.

Evidência exigida: CPU acima de 60% do request sob carga sustentada, `desiredReplicas/currentReplicas` subindo de 1 para mais de 1 (até 5), tarefas concluídas por diferentes workers e ausência de `FailedGetResourceMetric`/`ScalingActive=False`. Capture horários, CPU, réplicas atuais/desejadas, request/limit, iterações e `request_id`. Métricas são amostradas: subir imediatamente ou chegar sempre a 5 depende de capacidade, CPU, duração e inicialização. Se CPU ficar baixa, confira configuração efetiva e aumente duração/iterações dentro do limite. Pods Pending exigem conferir recursos dos nós.

Após terminar, acompanhe `/api/stats` até `pending=0`, `processing=0` e `unpublished=0`, sem outros produtores:

```powershell
Invoke-RestMethod http://127.0.0.1:8081/api/stats
kubectl -n battlesim get hpa service-b
kubectl -n battlesim top pods -l app=service-b
```

Continue observando **sem alterar HPA, CPU ou réplicas**. A janela de redução é 120 s e a política remove no máximo um Pod a cada 60 s, até voltar a 1. Permita vários minutos após esvaziar o backlog; CPU alta enquanto a fila esvazia não é falha de redução. Registre subida e descida com timestamps. Só depois da medição restaure a configuração normal:

```powershell
kubectl apply -k k8s
kubectl -n battlesim rollout status deployment/service-a --timeout=180s
kubectl -n battlesim rollout status deployment/service-b --timeout=180s
```

`minReplicas`, `maxReplicas`, alvo e janelas ficam em `k8s/base/worker-hpa.yaml`; request/limit ficam em `worker.yaml`. O Deployment omite `spec.replicas` para reaplicar Kustomize sem sobrescrever a escolha do HPA. Não escale manualmente com HPA ativo. Métrica de fila exigiria outro mecanismo e não foi adicionada.

## Validação sem cluster

```powershell
kubectl kustomize k8s
kubectl kustomize k8s/overlays/hpa-demo
& ./k8s/Test-Manifests.ps1
git diff --check -- k8s
```

Os dois renders produzem 12 recursos cada. O script verifica namespace, CPU, referências do ConfigMap com hash, ausência de Secret versionado, API uma réplica/Recreate/PVC, recursos, probes existentes, HPA e Ingress; também verifica sintaxe PowerShell e guardrails MIME/trace/CSP. Isso **não** valida todo o schema Kubernetes, sintaxe completa NGINX ou disponibilidade de storage, métricas e imagens. Complete com `--dry-run=server`, build de imagens e experimentos reais no cluster escolhido. Os experimentos já executados nesta máquina estão em [docs/kubernetes-validation.md](../docs/kubernetes-validation.md).

Não execute `kubectl delete -k k8s`, remova namespace ou PVCs para repetir experimentos: isso pode eliminar dados. Substitua somente Pods worker nos testes de reposição. Backup, restore e remoção de dados exigem procedimento próprio.

Referências primárias: [HPA e CPU](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/), [exemplo HPA](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/), [probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) e [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/).
