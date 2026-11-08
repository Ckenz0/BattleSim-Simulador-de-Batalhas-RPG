# Validação da primeira entrega

Verificada em 7 de novembro de 2026, no Windows com Docker Desktop/WSL2, containers Linux, Python 3.11 e Node.js 24 para o QA opcional do navegador.

## Testes executados

- `uv run pytest -m 'integration or not integration' -q`: **42 testes aprovados**, incluindo seis cenários reais com Docker Compose.
- Após as correções finais da interface, `uv run pytest -q`: **36 testes aprovados**; os seis de integração são selecionados explicitamente pelo comando acima.
- `node tests/browser.mjs`: fluxos de personagens, seleção, resultado, histórico, lote, validação, consulta encerrada em estado terminal, replay e recuperação de rede aprovados em desktop e celular, sem erros inesperados de console. O erro de rede injetado para testar a recuperação é esperado e registrado separadamente.
- `docker compose config --quiet`, `nginx -t` no container e `node --check frontend/js/app.js`: aprovados.

Os testes Python emitem um aviso de depreciação do TestClient do Starlette ao usar httpx. Não houve falha; a migração dessa dependência de teste pode ser feita junto de uma próxima atualização do lock.

## Cenários integrados

1. Criação de personagens, HTTP 202 e resultado consultado exclusivamente pelo NGINX.
2. Worker interrompido, tarefas persistidas, broker reiniciado e pendências concluídas após retomada.
3. Broker indisponível, aceitação das batalhas na outbox e recuperação automática.
4. Três workers compartilhando 36 batalhas, com IDs de worker distintos e sem duplicatas no histórico.
5. Mensagem inválida encaminhada para a fila de descarte, sem bloquear o consumidor.
6. API recriada, preservando dados SQLite e roteamento do NGINX.

A integração usa carga real de CPU configurada localmente em 500000 iterações. Os testes adicionam dados de demonstração e restauram uma réplica do worker. Cada nova execução produz novos registros; não interpretar o total histórico como uma única execução de carga.

## Revisão

Uma revisão independente do conjunto confirmou a topologia e o backend e apontou um erro de recuperação no formulário: criação já confirmada poderia ser apresentada como falha se a leitura seguinte da coleção falhasse. O erro foi reproduzido e corrigido com teste real no navegador. A resposta 201 agora atualiza a coleção localmente.

Também foram verificadas as mensagens de transporte em português e a reprodução dos ataques já calculados, com avanço manual quando movimento reduzido está ativo.

Kubernetes, remoção e reposição de Pods e HPA não foram executados nesta primeira etapa. O plano está em `k8s/README.md`.


## Evolução da arena 2D

A atualização adicionou cenário claro, sprites originais frente/costas, poses e efeitos de cada classe, narração, vida sincronizada, controle de reprodução e tela de vitória. A visão geral com equipes, inimigos, chefes e progressão está em game-roadmap.md.

Validação final desta evolução:

- 9 testes Node do controlador de reprodução aprovados, incluindo pausa reentrante, último golpe, descarte, velocidade e divulgação do vencedor no final.
- 36 testes Python de regras/API/persistência aprovados; permanece o aviso upstream de depreciação do TestClient. Os seis testes de integração Docker pertencem à rodada anterior e não foram repetidos por esta mudança de frontend.
- QA real do navegador aprovado em desktop/celular: criação e falhas de rede, duelos e histórico, classes iguais, entrada automática, projétil do arqueiro, pausa/navegação, movimento reduzido, lotes e ausência de novo POST ao rever.
- Regressões reais reproduzidas antes das correções: resposta antiga sobrepondo nova luta; histórico da mesma batalha após trocar seleção; estilo de vida baixa herdado em preview. Todos passaram após as correções.
- JavaScript, configuração do Compose, NGINX e respostas HTTP da interface/readiness verificados.

A revisão independente aprovou a apresentação visual e identificou a reabertura pelo histórico e a cor herdada de HP. As correções foram verificadas no navegador. Os prompts dos PNGs originais estão em frontend/assets/art-provenance.json e embutidos nos próprios arquivos.
