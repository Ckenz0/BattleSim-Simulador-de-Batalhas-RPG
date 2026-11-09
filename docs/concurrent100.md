# Demonstrar 100 batalhas concorrentes

O perfil `k8s/overlays/docker-desktop-concurrent100` prepara **5 workers com 20 slots cada**, antes de enviar um lote de 100. Cada batalha executa 10.000.000 de iterações PBKDF2-HMAC-SHA256, além da simulação, para tornar a concorrência observável. Não há espera artificial. As 100 tarefas compartilham CPU: isso não significa 100 núcleos nem promete aceleração de 100 vezes. A máquina local oferece 12 CPUs e aproximadamente 15 GiB; cada Pod worker continua limitado a 1 CPU e 256 MiB.

| Perfil | Slots por worker | HPA mínimo / máximo | Iterações CPU | Objetivo |
| --- | --- | --- | --- | --- |
| `docker-desktop` | 1 | 1 / 5 | 0 | Jogo normal |
| `docker-desktop-hpa` | 1 | 1 / 5 | 5.000.000 | Observar subida e descida automáticas |
| `docker-desktop-concurrent100` | 20 | 5 / 5 | 10.000.000 | Observar até 100 execuções concorrentes |

O último perfil fixa a capacidade aquecida pelo HPA e **não demonstra elasticidade**. Os perfis normais e de HPA continuam com limites de 1 a 5. O Deployment omite `spec.replicas`, inclusive no perfil fixo. O HPA pode levar alguns ciclos para preparar os cinco Pods; confirme os consumidores antes da carga.

## Preparar e atualizar as imagens

Execute PowerShell na raiz do repositório. O cluster Docker Desktop, addons, Secret e volumes já devem estar preparados conforme [k8s/local-setup.md](../k8s/local-setup.md). Confira o contexto e preserve `battlesim-rabbitmq`, `api-data` e `data-rabbitmq-0` existentes. Não recrie o Secret, namespace ou PVCs para mudar de perfil.

```powershell
kubectl config current-context
kubectl --context docker-desktop get nodes
& ./k8s/Test-Manifests.ps1
```

Uma imagem worker antiga ignora a nova variável e pode continuar executando somente uma tarefa por vez. O frontend Kubernetes também contém uma cópia dos arquivos, portanto mudanças na interface exigem outra imagem. O overlay fixa a revisão `concurrent100-v1` para ambas:

```powershell
$revision = 'concurrent100-v1'
docker build -f service-b/Dockerfile -t "battlesim-worker:$revision" .
docker build -f k8s/frontend.Dockerfile -t "battlesim-frontend:$revision" .
```

Para uma mudança posterior, escolha uma tag nova (por exemplo, data e hora), reconstrua ambas e atualize `images` de `k8s/overlays/docker-desktop-concurrent100/kustomization.yaml` com o mesmo valor. Não reutilize `concurrent100-v1` para conteúdo diferente:

```yaml
images:
  - name: battlesim-worker
    newTag: concurrent100-AAAAMMDD-HHMMSS
  - name: battlesim-frontend
    newTag: concurrent100-AAAAMMDD-HHMMSS
```

A API pode continuar com sua imagem atual; na primeira implantação também construa `battlesim-api:local` com `service-a/Dockerfile`. Na configuração Docker Desktop já validada, o cluster acessou o cache local de imagens. Em outra configuração, carregue as imagens no runtime do cluster pelo mecanismo próprio ou publique no registry configurado. `docker image ls` sozinho não comprova que o nó consegue usá-las. Os Pods usam `IfNotPresent`: reconstruir uma tag já armazenada no nó não garante atualização. Confirme a tag e `imageID` dos Pods após o rollout; `ImagePullBackOff` exige corrigir a disponibilidade da imagem, sem apagar dados.

## Aquecer os cinco consumidores

```powershell
kubectl --context docker-desktop apply --dry-run=server -k k8s/overlays/docker-desktop-concurrent100
kubectl --context docker-desktop apply -k k8s/overlays/docker-desktop-concurrent100
kubectl --context docker-desktop -n battlesim rollout status deployment/service-a --timeout=180s
kubectl --context docker-desktop -n battlesim rollout status deployment/service-b --timeout=300s
kubectl --context docker-desktop -n battlesim rollout status deployment/frontend --timeout=180s
kubectl --context docker-desktop -n battlesim get hpa service-b
kubectl --context docker-desktop -n battlesim get pods -l app=service-b -o wide
kubectl --context docker-desktop -n battlesim get pods -l app=service-b -o 'jsonpath={range .items[*]}{.metadata.name}{" image="}{.spec.containers[0].image}{" imageID="}{.status.containerStatuses[0].imageID}{"\n"}{end}'
kubectl --context docker-desktop -n battlesim logs -l app=service-b --prefix --tail=30 --max-log-requests=5
kubectl --context docker-desktop -n battlesim exec rabbitmq-0 -- rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers
& ./k8s/Start-LocalIngress.ps1
```

Espere cinco Pods da revisão atual e um `worker_ready` em cada um, com concorrência 20 e `cpu_iterations: 10000000`. Na fila **`battles.requests.v1`**, confira `consumers=5`, `messages_ready=0` e `messages_unacknowledged=0`. `Ready` do Kubernetes só confirma que o processo iniciou; os logs e o broker confirmam consumo. `rollout status` pode terminar antes de o HPA alcançar cinco réplicas. Não inicie enquanto houver Pods antigos, consumidores faltando ou tarefas de outro ensaio.

O ConfigMap de CPU tem hash e é compartilhado pela API e worker; mudar de perfil pode reiniciar a API com `Recreate`. Aguarde sua readiness. O host Ingress é `localhost`; acesse **http://localhost:8081**, com o port-forward do controller ativo.

## Enviar um único lote de 100

Abra **Arena**, selecione dois combatentes e vá para **Teste de carga**. Escolha **100 batalhas** e clique uma vez em **Solicitar lote**. Anote o identificador do lote e acompanhe o monitor, os resultados e os workers. Recarregar a página permite retomar o lote selecionado.

Para um ensaio repetível pela API, o exemplo abaixo cria dois personagens de teste e envia exatamente um POST de lote. Os registros permanecem no banco. Execute uma vez, sem outros produtores; não use `Invoke-Load.ps1`, pois ele repõe lotes continuamente.

```powershell
$baseUrl = 'http://localhost:8081'
$trace = 'concurrent100-' + [Guid]::NewGuid().ToString('N')
$headers = @{ 'X-Request-ID' = $trace }
$fighters = @()
foreach ($suffix in @('A', 'B')) {
    $body = @{ name = "$trace-$suffix"; class_name = 'warrior'; hp = 145; attack = 34; defense = 22; speed = 35 } | ConvertTo-Json
    $fighters += Invoke-RestMethod -Method POST -Uri "$baseUrl/api/characters" -Headers $headers -ContentType 'application/json' -Body $body
}
$body = @{ character_a_id = $fighters[0].id; character_b_id = $fighters[1].id; count = 100 } | ConvertTo-Json
$batch = Invoke-RestMethod -Method POST -Uri "$baseUrl/api/battles/batch" -Headers $headers -ContentType 'application/json' -Body $body
$batch | Select-Object batch_id, count, status
```

Um timeout no POST não autoriza repetir o envio: a API pode já ter aceitado o lote. HTTP 202 confirma aceitação persistida, e não início simultâneo de todas as tarefas.

## Medir o trabalho em andamento e a conclusão

Prepare outro terminal **antes** do envio. Execute repetidamente a amostra do broker durante a carga, registrando o horário:

```powershell
Get-Date -Format o
kubectl --context docker-desktop -n battlesim exec rabbitmq-0 -- rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers
kubectl --context docker-desktop -n battlesim top pods -l app=service-b
kubectl --context docker-desktop -n battlesim logs -l app=service-b --prefix --tail=150 --max-log-requests=5
```

O alvo observável na fila `battles.requests.v1` é **100 mensagens sem ACK, zero prontas e cinco consumidores** durante o trabalho. `messages_unacknowledged` conta entregas ainda sem confirmação; inclui publicação do resultado e não é um contador exato de threads dentro de PBKDF2. Combine essa amostra com `battle_processing`/`battle_finished` por `battle_id` e `worker_id`, CPU real e a configuração dos slots. Os testes do worker verificam execução sobreposta e o limite com tarefas bloqueadas controladas. Uma amostra tardia pode perder o pico; registre o que foi observado, sem inferir 100 a partir de cinco consumidores.

Os estados `pending`/`processing` do monitor e `/api/stats` chegam por eventos e podem atrasar em relação ao worker. Eles servem para acompanhar o lote, mas **não provam concorrência física**. Não use apenas um painel com 100 itens em processamento como evidência.

Para conferir o lote enviado pelo exemplo de API:

```powershell
$page = Invoke-RestMethod "$baseUrl/api/battles?batch_id=$($batch.batch_id)&limit=100"
$page.items | Group-Object status | Select-Object Name, Count
$page.items | Group-Object worker_id | Select-Object Name, Count
Invoke-RestMethod "$baseUrl/api/stats"
kubectl --context docker-desktop -n battlesim exec rabbitmq-0 -- rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers
```

Repita até `total=100` e as 100 batalhas terem estado terminal. Para uma execução bem-sucedida, espere 100 `completed`, zero `failed`, fila de pedidos vazia e outbox sem publicações pendentes. Registre horários, `batch_id`, `request_id`, tags/imageIDs, amostras do broker, CPU e distribuição por worker. O tempo depende de contenção e recursos; não há duração ou ganho de velocidade garantidos.

## Verificação automatizada e resultado observado

Com os cinco consumidores preparados e a fila vazia, este comando envia exatamente um lote de 100 e salva amostras do broker e dos resultados:

```powershell
uv run python scripts/verify_concurrent100.py
```

Não repete POSTs após timeout nem modifica o cluster. Ele só considera a verificação concluída quando observa 100 entregas sem ACK, zero mensagens prontas, cinco consumidores e os 100 resultados concluídos, distribuídos pelos cinco workers. O JSON completo fica em `.git/local-cluster/concurrent100-evidence.json`. Os estados da API são registrados separadamente das medições do broker.

Em **8 de novembro de 2026**, o lote `fb8a4758-1c05-4cf8-bbb2-82e07b80bdb5` teve este resultado:

| Medida | Observado |
| --- | --- |
| Batalhas aceitas juntas | 100, HTTP 202 |
| Consumidores / prefetch individual | 5 / 20 |
| Pico de mensagens entregues sem ACK | 100, com zero aguardando na fila |
| Amostras mantendo esse pico | De 2,78 s até 15,64 s após o envio |
| Resultados por worker | 20 em cada um dos cinco |
| Conclusão | 100 concluídas, zero falhas, em 36,31 s nesta máquina |

O perfil usa trabalho real de CPU adicional para manter o pico visível. A duração não é uma promessa para outras máquinas. Na primeira medição com cinco milhões de iterações, os logs mostraram sobreposição de 100 trabalhos, mas o coletor mais lento do broker capturou somente 99. O perfil final usa dez milhões de iterações para ampliar essa janela observável. A confirmação final combina configuração limitada e testes de execução sobreposta, medições do broker e resultados reais; não transforma contagens atrasadas da interface em medição de CPU.

Também passaram 67 testes Python de unidade/API, seis testes de integração no Compose, 21 testes JavaScript, QA da interface em desktop/celular e o fluxo real de aventura/arena/histórico no navegador pelo Kubernetes. A revisão independente não encontrou problemas críticos ou importantes pendentes.

## Encerramento e outros modos

O perfil usa `terminationGracePeriodSeconds: 75`, dando mais margem ao processo sob contenção que os 35 s dos outros perfis. Esse é o prazo externo do Kubernetes, não garantia de drenar 20 tarefas nem mecanismo para cancelar imediatamente código CPU em threads. O worker espera tarefas ativas por até 25 s; threads CPU já iniciadas podem continuar depois desse prazo e mensagens sem ACK podem voltar à fila e ser reexecutadas. Aguarde o lote terminar antes de trocar imagens ou perfil, e não force a remoção de Pods.

Para voltar ao jogo normal, depois de esvaziar a fila:

```powershell
kubectl --context docker-desktop apply -k k8s/overlays/docker-desktop
kubectl --context docker-desktop -n battlesim rollout status deployment/service-a --timeout=180s
kubectl --context docker-desktop -n battlesim rollout status deployment/service-b --timeout=300s
```

Isso restaura concorrência 1, CPU extra 0, grace de 35 s e HPA 1–5; o HPA reduz gradualmente conforme suas janelas. A base usa as imagens atuais `concurrent100-v1`, preservando o monitor de lotes ao trocar de perfil. Para demonstrar elasticidade, use o ensaio independente de [k8s/local-setup.md](../k8s/local-setup.md), com `docker-desktop-hpa` e estado inicial de uma réplica. Não apresente a configuração fixa 5/5 como subida ou descida automática.

No Compose, `WORKER_CONCURRENCY` também aceita inteiro de 1 a 20, com padrão **1**. Alterar o `.env` só passa a valer após recriar os workers, por exemplo `docker compose up -d --build --force-recreate service-b`. O Compose tem dados e porta próprios; o perfil 5 × 20 deste roteiro é Kubernetes. Nenhum desses procedimentos exige remover volumes ou executar `down -v`.
