# Recuperação sob falha e comparação de escala

Este ensaio verifica duas propriedades do projeto: recuperação de tarefas durante uma falha real de consumidor e efeito de aumentar o número de workers sob uma carga controlada. O [relatório de resultados](requirements-results.md) registra as medições executadas; os arquivos JSON detalhados são locais.

## Executar

Use o cluster local preparado pelo [roteiro Docker Desktop](../k8s/local-setup.md), com o [perfil de 100 batalhas](concurrent100.md) já ativo, cinco consumidores de prefetch 20 e nenhuma tarefa pendente. Mantenha o acesso em `http://localhost:8081` disponível. Na raiz do repositório:

```powershell
uv run pytest tests/test_cluster_experiments.py tests/test_experiment_metrics.py -q
uv run python scripts/run_requirements_experiments.py --allow-cluster-mutations
```

O flag é obrigatório porque o ensaio altera temporariamente a configuração do cluster e remove um Pod worker. O contexto aceito é somente `docker-desktop` e o alvo HTTP deve ser loopback, sem credenciais na URL. Antes de enviar tarefas, confere os recursos do perfil e a variável CPU efetiva dos cinco workers, exigindo dez milhões de iterações para a fase de falha. O teste cria dois combatentes e registros de batalhas; não apaga dados existentes. Execute sem outros produtores de carga.

Saída padrão: `.git/local-cluster/reliability-benchmark/evidence.json`. `--output` permite outro arquivo. O padrão é três repetições; `--repetitions 1` produz somente uma medição por cenário e oferece menos informação sobre variabilidade. O trabalho extra de CPU padrão é `5000000` iterações PBKDF2 por batalha no comparativo.

## Falha durante processamento

O script envia um único lote de 100 no perfil de cinco workers, com 20 slots por worker e dez milhões de iterações por tarefa. Ele espera entregas ativas no RabbitMQ e identifica, pelos logs, um worker processando IDs desse lote.

Antes de remover o Pod, confirma seu UID, label e cadeia de propriedade ReplicaSet → Deployment `service-b`. Solicita a remoção com cinco segundos de grace, sem `--force`. Esse prazo curto provoca a interrupção de trabalho ainda em andamento, em vez de aguardar toda a carga drenar. A API, o broker, os volumes, Secrets e outros Pods não são removidos pelo teste.

Para aprovar a recuperação, exige:

- Os mesmos 100 IDs aceitos, sem IDs faltantes, extras ou duplicados, todos `completed`.
- Um novo Pod Ready, com UID diferente do removido, e cinco consumidores ativos novamente.
- Novos `attempt_id` para batalhas iniciadas no worker removido: evidência de reentrega e nova execução, não apenas criação de outro Pod.
- Fila, tarefas em processamento e outbox drenadas.

A confirmação de consumo ocorre depois da publicação terminal. Ao perder a conexão, entregas sem ACK podem voltar à fila. Isso permite computar uma tarefa novamente; não implica gravar dois resultados para a mesma batalha. Os testes de persistência verificam a idempotência. Este lote usa duelos livres, sem recompensas; a proteção contra recompensa duplicada da Aventura é coberta separadamente pelos testes de domínio.

## Comparativo controlado

Após a recuperação, o script compara 1, 3 e 5 workers. São mantidos:

| Variável | Valor |
| --- | --- |
| Batalhas por medição | 100, com os mesmos dois personagens |
| Iterações CPU por batalha | 5.000.000, trabalho real |
| Slots por worker | 20 |
| CPU por worker | request `250m`, limit `1` |
| Memória por worker | request `128Mi`, limit `256Mi` |
| Repetições por cenário | 3 |

O HPA fica com mínimo e máximo iguais ao número do cenário durante a medição. Portanto, este é um **comparativo de escala horizontal controlada**. O teste independente de elasticidade automática permanece documentado em [kubernetes-validation.md](kubernetes-validation.md).

Cada cenário executa primeiro um aquecimento de `20 × número de workers` tarefas, excluído das estatísticas. Depois vêm as três medições de 100, sempre aguardando a conclusão e o esvaziamento antes da próxima. Um Pod substituído ou container reiniciado durante uma medição invalida aquela comparação. A versão final da ferramenta também confere e registra imagem, recursos, concorrência e configuração de CPU antes/depois de cada medição.

## Significado dos números

- **Tempo total e vazão:** relógio monotônico do cliente, do envio até a observação de todos os resultados. Vazão é `100 / segundos`. A consulta periódica pode acrescentar até aproximadamente um segundo à observação final.
- **Latência por batalha:** `updated_at - created_at` da API, do registro da tarefa até a persistência do resultado. Não é somente a duração do motor.
- **Espera até o worker:** primeiro log `battle_processing` menos `created_at`. Inclui outbox, transporte e admissão; não representa apenas tempo dentro da fila RabbitMQ. O script exige cobertura dos 100 IDs para comparar essa medida.
- **Duração de processamento:** `processing_ms` informado pelo worker; inclui a carga extra de CPU e a contenção entre tarefas.
- **CPU:** diferença de `usage_usec` do cgroup de cada Pod, antes e depois. CPU total é a soma desses deltas em segundos. A razão CPU total / tempo total aproxima os núcleos ocupados no conjunto dos workers. As leituras envolvem o intervalo do lote e incluem pequeno overhead de diagnóstico; não são uma medição exata de ocupação instantânea nem amostras do Metrics Server.
- **p95:** percentil por ordem, sem interpolação: posição `ceil(0,95 × quantidade)`. O resumo compara a mediana dos p95 das três rodadas; não mistura as 300 amostras em um único percentil.
- **Ganho de velocidade:** mediana do tempo com um worker dividida pela mediana do cenário. Eficiência é esse ganho dividido pelo número de workers.

As rodadas ocorrem na ordem 1 → 3 → 5, na mesma máquina. Limites de CPU, frequência do processador, custo da API/outbox, coleta e carga de fundo afetam os resultados. Não extrapole as medições locais para outros ambientes nem confunda 100 tarefas concorrentes com 100 núcleos.

## Restauração e interrupções

Antes de alterar CPU ou limites do HPA, a ferramenta guarda os valores originais. Ao terminar, falhar ou receber Ctrl+C, tenta drenar as tarefas e restaura somente o override de CPU e os limites originais do HPA. Não reaplica toda a aplicação nem sobrescreve imagens, dados ou Secrets.

O arquivo conserva evidência parcial em caso de falha. Só aceite `verified=true` junto de `restored=true`. Um timeout de POST não é repetido automaticamente: o lote pode já ter sido aceito. Se a restauração falhar, confira o erro salvo, mantenha o acesso local disponível, aguarde as tarefas e restaure os valores exatos gravados na evidência:

```powershell
@'
import json, sys
sys.path.insert(0, 'scripts')
from cluster_experiments import LocalCluster
with open('.git/local-cluster/reliability-benchmark/evidence.json', encoding='utf-8') as stream:
    original = json.load(stream)['original_settings']
client = LocalCluster(allow_mutations=True)
client.restore_settings(original)
print(client.runtime_cpu_iterations(client.wait_workers(original['replicas'])))
'@ | uv run python -
kubectl --context docker-desktop -n battlesim rollout status deployment/service-b --timeout=300s
kubectl --context docker-desktop -n battlesim get pods,hpa
```

O helper remove o override de CPU criado pelo teste quando ele não existia originalmente, ou restaura a entrada anterior quando existia, além dos limites do HPA. Reaplicar apenas o Kustomize pode preservar um override adicionado fora do último `apply`; por isso não é o procedimento de recuperação usado aqui. Se o JSON não tiver `original_settings`, a validação inicial parou antes de entrar no bloco de alterações.

## Propriedades técnicas verificadas

| Propriedade | Evidência |
| --- | --- |
| Quatro componentes no Compose e entrada somente pelo NGINX | [Arquitetura](architecture.md), `compose.yml` e testes de integração |
| Serviços A/B desacoplados por RabbitMQ | Contratos em `contracts/`, configuração dos serviços e correlação de logs |
| Consumidor interrompido e retomada de pendências | [Roteiro Compose](demo.md), testes de integração e ensaio de falha acima |
| Persistência do broker e armazenamento | Volumes do Compose, PVCs Kubernetes e [validações](kubernetes-validation.md) |
| Substituição automática de Pod | UID antes/depois e reentregas do ensaio de falha |
| Alteração da quantidade de réplicas | Comparativo controlado de 1, 3 e 5 workers |
| Aumento/redução automática via HPA de CPU | Experimento separado [1 → 5 → 1](kubernetes-validation.md) |
| Decisões arquiteturais e limites operacionais documentados | Este roteiro, relatório de resultados e [arquitetura efetiva](architecture.md) |

Referências: [encerramento de Pods](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination) e [confirmações/reentrega RabbitMQ](https://www.rabbitmq.com/docs/confirms).
