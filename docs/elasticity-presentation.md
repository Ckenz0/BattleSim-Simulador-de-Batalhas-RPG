# Apresentar elasticidade com a Sala de Controle

Abra **http://localhost:8081/#control** no Kubernetes local. O Compose em **http://localhost:8080/#control** também coleta aplicação e filas; nele, Kubernetes, HPA e CPU dos workers aparecem como indisponíveis.

## Roteiro para a apresentação

1. Siga a [validação da entrega](delivery-validation.md) para conferir prontidão, métricas e o perfil `docker-desktop-hpa`. O indicador precisa mostrar **HPA variável · 1 a 5 workers**. Limites iguais são identificados como capacidade fixa.
2. Clique em **Iniciar coleta** antes de gerar carga. Aguarde a primeira leitura para estabelecer a linha de base.
3. Em outro terminal, inicie o gerador existente:

   ```powershell
   & ./k8s/Invoke-Load.ps1 -BaseUrl http://localhost:8081 -DurationSeconds 120 -TargetBacklog 30 -BatchSize 15
   ```

4. Mantenha a Sala de Controle visível. Explique os três gráficos: réplicas atuais/desejadas; CPU em percentual do request e meta do HPA; mensagens prontas e sem ACK na fila de pedidos. A linha contínua e a tracejada identificam as séries também sem depender da cor. A tabela de leituras recentes contém todos os valores dos gráficos.
5. Após o gerador terminar, acompanhe o esvaziamento da fila e a redução das réplicas. O HPA pode levar vários minutos para reduzir; a interface apenas observa suas decisões.
6. Clique em **Encerrar coleta**, depois em **Exportar JSON** e/ou **Exportar CSV**. Também é possível exportar uma cópia da coleta em andamento.
7. Para repetir, use **Nova coleta**. A ação pede uma escolha explícita antes de descartar o resultado anterior.

O botão **Abrir teste de carga** usa a navegação normal da aplicação. Sair da sala ou ocultar a aba pausa a coleta: para um gráfico contínuo, gere carga pelo terminal e mantenha esta aba visível. O navegador não altera réplicas, perfis ou recursos.

## O que o registro significa

- A coleta fica em memória nesta aba. Exporte antes de fechar ou recarregar; há um aviso do navegador ao sair durante uma coleta ativa. Não há gravação automática no servidor.
- Cada consulta bem-sucedida cria uma amostra com horário de recebimento e snapshot original de `/api/control`. A cadência normal é de cinco segundos, sem consultas adicionais de métricas.
- As fontes possuem horários próprios e o backend pode retornar dados em cache. Horário de recebimento e horário observado são diferentes e ambos ficam no JSON/CSV.
- Uma falha de consulta cria uma amostra com valores ausentes; a última leitura válida não é reutilizada como nova medição. Zero medido continua sendo zero.
- Pausas explícitas, intervalos maiores que 15 segundos e métricas ausentes interrompem as linhas. A interface não reconstrói os dados do intervalo ausente. Pausas ficam registradas no JSON.
- O limite é de **720 leituras**, incluindo falhas. Ao atingir o limite, a coleta é encerrada sem apagar as primeiras amostras. Em condições normais isso corresponde a aproximadamente uma hora; pausas estendem o tempo de relógio.
- O resumo de réplicas mostra transições observadas. Ele não atribui automaticamente uma mudança ao HPA: alterações manuais também podem produzir mudanças nas réplicas. Consulte as condições do HPA para explicar causalidade.
- O perfil é derivado dos limites observados, sem presumir qual overlay foi aplicado. Mudanças dos limites durante a coleta aparecem como aviso e ficam preservadas nas amostras.
- A variação de concluídas usa o contador global da aplicação entre a primeira e a última leitura; inclui outras cargas e não comprova o resultado de um lote específico. Se o contador diminuir, a variação fica indisponível.

O JSON contém versão do formato, início/fim, estado, limite, origem, resumo, pausas e snapshots. O CSV contém as séries dos gráficos, perfil por amostra, contagem global e horários das fontes; células vazias representam dados indisponíveis. O arquivo usa UTF-8 com BOM para abertura em planilhas.

## Atualização local

No Compose, `frontend/` já é montado pelo NGINX; recarregue a página. Para Kubernetes, construa a nova imagem, valide e atualize somente o frontend:

```powershell
docker build -f k8s/frontend.Dockerfile -t battlesim-frontend:presentation-v1 .
& ./k8s/Test-Manifests.ps1
kubectl --context docker-desktop -n battlesim set image deployment/frontend frontend=battlesim-frontend:presentation-v1 --dry-run=server
kubectl --context docker-desktop -n battlesim set image deployment/frontend frontend=battlesim-frontend:presentation-v1
kubectl --context docker-desktop -n battlesim rollout status deployment/frontend --timeout=180s
& ./k8s/Start-LocalIngress.ps1
```

Isso mantém API, workers, HPA, Secret e volumes existentes. Os manifests dos cinco perfis também usam a nova tag do frontend. Em outro runtime, disponibilize a imagem ao cluster conforme o [setup](../k8s/local-setup.md).

## Verificar a interface

```powershell
node --test tests/*.test.mjs
node tests/control-browser.mjs
# Para a mesma verificação no Kubernetes:
$env:BATTLESIM_BASE_URL = 'http://localhost:8081'
$env:BATTLESIM_CONTROL_QA_DIR = '.git/elasticity-cluster-ui'
node tests/control-browser.mjs
```

O roteiro de navegador cria uma batalha real, registra duas consultas reais e confere os downloads JSON/CSV. Depois usa respostas e relógio explicitamente isolados para testar subida/descida, perfil fixo, falhas, métricas ausentes e responsividade. Os gráficos dessas respostas isoladas não constituem evidência de uma nova execução real do HPA. Relatório e capturas ficam no diretório local de QA, fora do versionamento.

## Validação em 13/11/2026

Passaram **152 testes Python**, **41 testes JavaScript**, os guardrails dos **cinco perfis Kubernetes**, o build e o rollout de `presentation-v1`. O detector de interface não apontou ocorrências. O roteiro de navegador passou no Compose e no Kubernetes pelo Ingress, com viewports de 1440 e 390 px, duas leituras reais por ambiente, downloads JSON/CSV e nenhum erro JavaScript observado.

O cluster terminou com HPA variável de 1 a 5, uma réplica e fontes de broker, Kubernetes e métricas disponíveis. Nesta validação não foi repetido o ciclo real completo de carga/HPA nem os oito testes de recuperação Compose. O [registro resumido](evidence/presentation-validation-2026-11-13.json) distingue as verificações reais dos cenários isolados.
