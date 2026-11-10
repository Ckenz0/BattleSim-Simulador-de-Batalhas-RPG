# Sala de Controle

A Sala de Controle reúne o estado persistido das batalhas, o caminho das mensagens, as filas RabbitMQ e as observações do cluster. Abra a interface pelo mesmo NGINX usado pelo jogo. No Kubernetes local, o endereço continua `http://localhost:8081`; no Compose, use a porta configurada em `APP_PORT` (padrão `8080`).

## Consultas

| Endpoint | Conteúdo |
| --- | --- |
| `GET /api/control` | Snapshot da aplicação, outbox, filas, workers, recursos e HPA, com disponibilidade de cada fonte |
| `GET /api/battles/{battle_id}/trace?limit=100&offset=0` | Observações persistidas da batalha, em ordem de gravação, com paginação |

O trace aceita `limit` de 1 a 200 e `offset` a partir de zero; uma batalha inexistente retorna 404. A resposta inclui `request_id`, `batch_id`, estado atual, `published_at`, `coverage`, `total`, `items`, `limit` e `offset`. As consultas não enviam tarefas, alteram réplicas ou repetem batalhas.

O snapshot combina fontes amostradas em momentos diferentes. Estado `processing` no SQLite, mensagens não confirmadas no broker, Pods `Ready` e CPU medida representam observações diferentes: seus valores podem divergir durante processamento e reconexão. Slots configurados por worker representam capacidade declarada, e não contagem medida de batalhas executando simultaneamente. O perfil normal usa um slot por worker; `docker-desktop-concurrent100` usa vinte e HPA fixo em cinco workers. Esse perfil demonstra capacidade preparada, sem comprovar elasticidade.

## Trace: somente observações reais

`accepted` é registrado na mesma transação que aceita a batalha e sua outbox. `published` é gravado depois do publisher confirm e da atualização da outbox. Eventos `processing`, `completed` e `failed` são registrados quando recebidos pela API. Uma confirmação indica o que a API observou; não prova o instante de entrega ao worker nem o ACK da tarefa. O sistema não cria etapas intermediárias, percentuais ou timestamps para preencher lacunas.

Cada item informa `occurred_at` (horário do evento na origem), `observed_at` (horário de gravação na API), `event_id`, `worker_id`, `attempt_id`, `applied`, `reason`, `deliveries` e `last_received_at`, quando aplicáveis. A ordem de gravação permanece estável mesmo com eventos atrasados ou relógios diferentes. O `request_id` relaciona a aceitação à requisição que atravessou NGINX; o identificador da consulta de trace pertence à própria consulta.

Reentregas do mesmo `event_id` incrementam `deliveries` e atualizam `last_received_at`, sem criar outra transição. `applied=false` e `reason=already_terminal` identificam um evento ignorado porque a batalha já tinha estado terminal. `duplicate_before_tracing` indica evento reconhecido pela deduplicação anterior à implantação do trace. O primeiro resultado terminal aceito continua prevalecendo.

Batalhas criadas com o trace têm `coverage=from_creation`. Batalhas já existentes recebem `coverage=legacy_partial`: podem ter observações novas ou nenhuma observação. Seus campos históricos continuam acessíveis, mas a migração não inventa um histórico de etapas passadas. Mesmo `from_creation` descreve cobertura da gravação na API, sem prometer uma instrumentação distribuída completa.

## Fontes e falhas de métricas

O coletor da API consulta somente `http://rabbitmq:15692/metrics/per-object` para obter métricas das filas `battles.requests.v1` e `battles.events.v1`, no vhost `/`. O exporter fornece mensagens prontas, não confirmadas e consumidores quando essas séries estão disponíveis. Os dados são amostras do broker, sem estimar fila a partir do número de batalhas no banco. Uma falha de DNS, timeout, HTTP, resposta inválida ou série ausente aparece como indisponibilidade da fonte ou do campo, nunca como fila vazia ou CPU zero.

As fontes usam `status=ok`, `unavailable` ou `not_configured`. `observed_at` só é preenchido após uma observação bem-sucedida. `error_code` apresenta categorias fixas (`timeout`, `connection_error`, `tls_error`, `invalid_response`, `http_NNN`), sem expor tokens ou mensagens brutas da conexão. O cluster mantém dados de Pods e Deployment se somente HPA ou Metrics Server falhar: confira separadamente `hpa_error_code`, `metrics_status` e `metrics_error_code`. Métricas de uso ausentes por Pod permanecem `null`; `metrics_observed_at` é o timestamp mais antigo entre as amostras correspondentes recebidas do servidor.

No Kubernetes, o coletor usa `KUBERNETES_SERVICE_HOST` e `KUBERNETES_SERVICE_PORT`, o token e a CA montados em `/var/run/secrets/kubernetes.io/serviceaccount/` e o namespace desse mesmo diretório. TLS da API Kubernetes é validado com essa CA. Não há kubeconfig, token estático ou endereço do cluster embutido na imagem.

No Compose, RabbitMQ continua disponível para observação, mas não existe configuração de acesso ao Kubernetes: a seção de cluster informa `not_configured`. Em Kubernetes, falta de Metrics Server, RBAC insuficiente, TLS inválido ou API indisponível torna a fonte afetada indisponível; os dados persistidos da aplicação e as outras fontes continuam úteis. Ausência de CPU não prova ociosidade nem sucesso do HPA. Compare réplicas desejadas com as disponíveis e os horários observados; para investigar decisões do HPA, consulte suas condições pelo `kubectl describe hpa service-b -n battlesim`.

## Permissões e rede

Somente a API usa o `ServiceAccount/battlesim-observer`, com montagem de token habilitada no Pod. O ServiceAccount desabilita montagem automática por padrão; worker, frontend e broker continuam sem token. `Role` e `RoleBinding` são restritos ao namespace `battlesim`:

| Grupo | Recurso | Verbos | Restrição |
| --- | --- | --- | --- |
| Core | `pods` | `get`, `list` | Namespace `battlesim` |
| `apps` | `deployments` | `get` | Apenas `service-b` |
| `autoscaling` | `horizontalpodautoscalers` | `get` | Apenas `service-b` |
| `metrics.k8s.io` | `pods` | `get`, `list` | Namespace `battlesim` |

Não há `ClusterRole`, leitura de Secrets, logs ou exec, acesso a outros namespaces ou verbos de escrita. A listagem de Pods é autorizada no namespace inteiro; filtros do coletor selecionam os workloads observados e não reduzem a autorização RBAC. Credenciais do broker continuam no Secret existente, referenciado pelo Pod, sem permissão do observador para consultar Secrets pela API.

O navegador acessa somente NGINX. API, AMQP e exporter não recebem portas publicadas no host, NodePort, LoadBalancer ou Ingress próprios. Kubernetes acrescenta a porta `15692` ao Service headless interno de RabbitMQ; Compose declara essa porta somente com `expose` e mantém a rede `internal`. O endpoint de métricas não exige abrir a interface de gerenciamento do RabbitMQ.

O plugin `rabbitmq_prometheus` já é habilitado na imagem oficial `rabbitmq:4.2-alpine`: a inspeção estática do histórico da imagem local, versão 4.2.9, encontrou a instrução `rabbitmq-plugins enable --offline rabbitmq_prometheus`. O [Dockerfile oficial da linha 4.2](https://github.com/docker-library/rabbitmq/blob/master/4.2/alpine/Dockerfile) confirma a configuração. O [endpoint por objeto do RabbitMQ](https://www.rabbitmq.com/docs/prometheus) mantém as métricas de cada fila sem mudar a configuração global de agregação.

## Atualizar e validar

API e frontend têm uma nova revisão; o worker mantém a revisão existente:

```powershell
docker build -f service-a/Dockerfile -t battlesim-api:control-v1 .
docker build -f k8s/frontend.Dockerfile -t battlesim-frontend:control-v1 .
# Construa o worker somente se a imagem ainda nao estiver disponivel no runtime.
docker build -f service-b/Dockerfile -t battlesim-worker:concurrent100-v1 .
& ./k8s/Test-Manifests.ps1
git diff --check -- k8s compose.yml docs/control-room.md
```

As tags estão fixadas nos manifests. O runtime do cluster precisa ter acesso às imagens; `IfNotPresent` não atualiza conteúdo de uma tag reutilizada. Para revisões futuras, use outra tag e atualize `images`. As instruções antigas do ensaio de concorrência em `docs/concurrent100.md` descrevem as imagens daquele ensaio; para a Sala de Controle, use as revisões acima.

O teste local renderiza a base e os quatro overlays, com quinze objetos cada. Verifica o conjunto exato de permissões de leitura, vínculo do ServiceAccount, montagem de token somente na API, portas internas, versões das imagens e correspondência entre concorrência do worker e `CONTROL_WORKER_CONCURRENCY` (`1` ou `20`). Também preserva as verificações de PVC, HPA, probes, ConfigMap e sintaxe PowerShell. Renderização estática não comprova schema do servidor, disponibilidade de imagens, acesso RBAC efetivo, resposta do exporter ou observação real de carga.

Antes de uma atualização autorizada no cluster, siga [k8s/local-setup.md](../k8s/local-setup.md) para conferir contexto, imagens e validação pelo servidor. Preserve o namespace, o Secret `battlesim-rabbitmq`, o PVC `api-data` e `data-rabbitmq-0`. A Sala de Controle não exige recriar credenciais ou dados. O banco mantém a API com uma réplica e estratégia `Recreate`.

## Validação observada em 10/11/2026

A entrega passou em 152 testes Python, 30 testes JavaScript e oito testes de integração no Compose. A interface foi exercitada em Edge com desktop de 1440 px e celular de 390 px: consultas reais, entrada pelo histórico, UUID inexistente, pausa por visibilidade e ausência de overflow. Respostas isoladas de teste cobriram falhas, métricas ausentes e paginação de 100 + 5 eventos; essas respostas não são evidência de carga real.

O cluster Docker Desktop estava preso na inicialização e voltou após um reinício normal, preservando os PVCs e o Secret existentes. A validação pelo servidor e a implantação de `control-v1` passaram. A consulta pelo Ingress retornou cinco workers prontos, vinte slots por worker, filas reais e CPU/memória do Metrics Server. A autorização efetiva permitiu ler Pods no namespace e negou leitura de Secrets e alteração do Deployment worker. A interface também passou pelo mesmo roteiro de navegador no Kubernetes.

Um lote real de 100 batalhas terminou com **100 concluídas e zero falhas em 33,7 segundos**, com os 100 percursos verificados. O coletor observou pico de 100 mensagens sem ACK e uso de CPU por worker, conferido com `kubectl top`. As filas terminaram vazias. O [registro resumido](evidence/control-room-results.json) contém IDs, horários, configuração e limites. Esta é uma execução observada; não substitui o ensaio repetido de desempenho. O HPA permaneceu fixo em 5/5 neste perfil.

Para repetir os testes de interface contra o cluster:

```powershell
$env:BATTLESIM_BASE_URL = 'http://localhost:8081'
$env:BATTLESIM_CONTROL_QA_DIR = '.git/control-cluster-ui'
node tests/control-browser.mjs
```

O roteiro cria uma batalha real e usa respostas explicitamente isoladas para os cenários adicionais. Capturas e relatório ficam no diretório local indicado.
