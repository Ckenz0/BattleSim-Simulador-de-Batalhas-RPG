# Cluster local com Docker Desktop

O [perfil de 100 batalhas concorrentes](../docs/concurrent100.md) usa o mesmo cluster e acesso local, com cinco workers aquecidos e 20 slots por worker. Seu HPA fixo 5/5 demonstra concorrência; o ensaio de elasticidade deste documento mantém HPA 1–5 e concorrência 1.

Este procedimento usa o Kubernetes integrado do Docker Desktop no Windows, em modo **kind**, com um nó. O Compose em `8080` e seus volumes são independentes. O cluster mantém outra base de personagens/aventuras; não importa os dados do Compose.

## Preparação e implantação

1. No Docker Desktop, abra **Kubernetes → Create cluster**, selecione **kind**, um nó e a versão disponível. A instalação verificada usa Kubernetes `1.36.1` e containerd `2.3.1`.
2. Espere o cluster iniciar e selecione seu contexto:

```powershell
kubectl config use-context docker-desktop
kubectl --context docker-desktop get nodes
kubectl --context docker-desktop get storageclass
```

O nó deve estar `Ready`. É necessária uma StorageClass padrão; nesta máquina, `standard` usa `rancher.io/local-path`. Os volumes desta demonstração são locais ao nó. Não resete o cluster para repetir os testes: o reset pode apagar seus dados.

Na raiz do repositório, construa as imagens atuais:

```powershell
docker build -f service-a/Dockerfile -t battlesim-api:control-v1 .
docker build -f service-b/Dockerfile -t battlesim-worker:concurrent100-v1 .
docker build -f k8s/frontend.Dockerfile -t battlesim-frontend:control-v1 .
```

Na configuração testada, o cluster do Docker Desktop acessou essas imagens locais diretamente. Isso foi confirmado pela execução dos Pods e seus eventos. Em outro runtime, siga o mecanismo de carregamento de imagens do ambiente; não suponha que a imagem existe no nó apenas porque aparece em `docker image ls`.

Instale os addons locais com versões fixadas: **F5 NGINX Ingress Controller OSS 5.7.1** e **Metrics Server 0.9.1**. Kustomize baixa manifests dos repositórios oficiais; requer internet. NGINX usa somente Ingress padrão, com recursos customizados desativados. O Service do controller é interno; o acesso ao navegador usa um port-forward para loopback.

```powershell
# O namespace precisa existir antes do dry-run dos recursos que ele contém.
kubectl --context docker-desktop create namespace nginx-ingress --dry-run=client -o yaml |
    kubectl --context docker-desktop apply -f -
kubectl --context docker-desktop apply --dry-run=server -k k8s/addons/nginx
kubectl --context docker-desktop apply -k k8s/addons/nginx
kubectl --context docker-desktop apply -k k8s/addons/metrics-server
kubectl --context docker-desktop -n nginx-ingress rollout status deployment/nginx-ingress --timeout=180s
kubectl --context docker-desktop wait --for=condition=Available apiservice/v1beta1.metrics.k8s.io --timeout=180s
kubectl --context docker-desktop top nodes
```

**Certificado do kubelet no ambiente local:** o Metrics Server original iniciou, mas registrou `x509: cannot validate certificate ... because it doesn't contain any IP SANs`. Por isso, este addon **para Docker Desktop/kind** acrescenta `--kubelet-insecure-tls`, mantendo o transporte TLS e a autenticação, mas desativando a validação do certificado do kubelet. Não use esse ajuste em produção; configure certificados de servidor válidos e a CA apropriada. A opção não altera TLS do navegador, Docker, API Kubernetes ou sistema operacional.

Crie o namespace e, somente na primeira implantação, o Secret do RabbitMQ. O gerador não imprime nem grava a senha e recusa sobrescrever um Secret existente:

```powershell
kubectl --context docker-desktop apply -f k8s/base/namespace.yaml
# Confirme current-context docker-desktop; execute apenas se o Secret ainda não existe:
kubectl config current-context
& ./k8s/New-Secret.ps1
kubectl --context docker-desktop apply --dry-run=server -k k8s/overlays/docker-desktop
kubectl --context docker-desktop apply -k k8s/overlays/docker-desktop
kubectl --context docker-desktop -n battlesim rollout status statefulset/rabbitmq --timeout=180s
kubectl --context docker-desktop -n battlesim rollout status deployment/service-a --timeout=180s
kubectl --context docker-desktop -n battlesim rollout status deployment/service-b --timeout=180s
kubectl --context docker-desktop -n battlesim rollout status deployment/frontend --timeout=180s
kubectl --context docker-desktop -n battlesim get pods,pvc,ingress,hpa
& ./k8s/Start-LocalIngress.ps1
```

Abra **http://localhost:8081/#adventure**. O caminho é **navegador → port-forward do controller → Ingress NGINX → frontend → API**. O overlay usa o host `localhost`; abrir apenas `127.0.0.1` não seleciona essa regra. Não é necessário editar o arquivo hosts. Os módulos `.mjs` continuam com MIME JavaScript e a correlação `X-Request-ID` atravessa os proxies.

`Start-LocalIngress.ps1` inicia `kubectl` em segundo plano, sem janela, somente em `127.0.0.1` e `::1`. Ele reutiliza um forward correspondente já ativo e recusa uma porta ocupada por outro processo. Logs e PID ficam em `.git/local-cluster/`. Execute novamente após reiniciar o cluster ou o controller. Para encerrar o acesso pelo navegador, consulte o PID salvo, confira que pertence a esse `kubectl` e encerre somente esse processo. Para pausar o ambiente, encerre o Docker Desktop. Não use **Stop/Reset cluster** como rotina de pausa: essas ações podem remover componentes e dados do cluster.

## Testar o HPA

Métricas de CPU precisam estar disponíveis antes da carga:

```powershell
kubectl --context docker-desktop -n battlesim top pods
kubectl --context docker-desktop -n battlesim get hpa service-b
# Estado inicial: uma réplica, sem fila pendente.
kubectl --context docker-desktop -n battlesim delete hpa service-b --ignore-not-found
kubectl --context docker-desktop -n battlesim scale deployment/service-b --replicas=1
kubectl --context docker-desktop apply -k k8s/overlays/docker-desktop-hpa
kubectl --context docker-desktop -n battlesim rollout status deployment/service-a --timeout=180s
kubectl --context docker-desktop -n battlesim rollout status deployment/service-b --timeout=180s
kubectl --context docker-desktop -n battlesim logs deployment/service-b --tail=10
& ./k8s/Invoke-Load.ps1 -BaseUrl http://localhost:8081 -DurationSeconds 120 -TargetBacklog 30 -BatchSize 15
```

O overlay mantém o host local e habilita `5000000` iterações PBKDF2 por batalha. Em outro terminal, acompanhe `kubectl --context docker-desktop -n battlesim get hpa service-b -w` e `top pods`. Alvo: 60% do request `250m`; limite de 1 a 5 réplicas. A janela de redução é de 120 segundos, removendo até um Pod por minuto. Depois da carga, espere a fila zerar e registre a redução **sem escalar manualmente**. O roteiro detalhado e os critérios estão em [README.md](README.md).

Somente após observar a redução, restaure o modo de jogo normal:

```powershell
kubectl --context docker-desktop apply -k k8s/overlays/docker-desktop
kubectl --context docker-desktop -n battlesim rollout status deployment/service-a --timeout=180s
kubectl --context docker-desktop -n battlesim rollout status deployment/service-b --timeout=180s
```

Isso preserva os volumes e o Ingress local. Reaplicar a base genérica ou o overlay `hpa-demo` troca o host de volta para `battlesim.local`; neste ambiente, use os overlays `docker-desktop` e `docker-desktop-hpa`.

Referências: [Docker Desktop Kubernetes](https://docs.docker.com/desktop/use-desktop/kubernetes/), [NGINX com manifests](https://docs.nginx.com/nginx-ingress-controller/install/manifests/), [Metrics Server](https://github.com/kubernetes-sigs/metrics-server) e [opções de certificado do kubelet](https://github.com/kubernetes-sigs/metrics-server/blob/master/docs/command-line-flags.txt).
