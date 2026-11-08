# Arquitetura e garantias

## Entrada e correlação

O navegador conhece apenas NGINX. A rede edge permite publicar sua porta no host; a rede internal isola API, worker e broker. NGINX resolve service-a pelo DNS do Docker, inclusive após recriação do container.

NGINX aceita um X-Request-ID com até 128 caracteres seguros ou gera um identificador. Esse valor chega à API, à tarefa e aos logs do worker. Logs da API incluem battle_id e batch_id; os eventos também registram worker_id e attempt_id. O log de acesso do NGINX identifica a requisição inicial, relacionada à batalha pelo evento battle_accepted da API.

## SQLite e outbox

SQLite usa WAL, busy_timeout e transações curtas. Cada operação abre e fecha sua conexão; as transações de escrita da criação e aplicação de eventos começam com BEGIN IMMEDIATE. Batalhas em lote são gravadas atomicamente.

Batalha e sua tarefa na outbox são persistidas juntas. A resposta 202 confirma aceitação no armazenamento local, não execução nem publicação já confirmada. O publicador tenta novamente após indisponibilidade do broker. Só marca published_at depois do publisher confirm. A API consegue receber novas operações enquanto o broker ou worker estão indisponíveis, desde que seu SQLite e disco continuem disponíveis.

Uma queda entre confirmação do broker e atualização da outbox pode reenviar a tarefa. Não existe uma transação distribuída entre SQLite e RabbitMQ.

## Contratos e RabbitMQ

Modelos Pydantic compartilhados são a autoridade dos contratos. Esquemas gerados em contracts/schemas/ usam schema_version=1; versões incompatíveis são rejeitadas.

| Fila | Conteúdo | Consumidor |
| --- | --- | --- |
| battles.requests.v1 | BattleTask: battle_id, snapshots dos dois personagens, seed, max_actions, request_id e created_at | Worker |
| battles.events.v1 | BattleEvent: event_id, battle_id, worker_id, attempt_id, occurred_at, status e resultado/erro | API |
| battles.dead.v1 | Mensagens rejeitadas sem requeue | Inspeção operacional |

Filas duráveis, mensagens persistentes, publicação obrigatória com confirmação e ACK manual. Ambas as filas de trabalho encaminham rejeições para battles.dead.v1 pelo exchange padrão. Uma única instância de RabbitMQ é usada no MVP.

O worker tem prefetch 1 e executa uma batalha por vez. Instâncias diferentes competem pela mesma fila. Eventos processing e terminais percorrem o RabbitMQ; não há comunicação direta A/B.

Resultado contém outcome, winner_id, turns, ataques, dano por combatente e vida final. Snapshot e seed estão na batalha original. processing_ms do evento inclui a simulação e a carga artificial de CPU; não inclui espera em fila. Média apresentada considera somente batalhas concluídas.

## Entrega, deduplicação e falhas

O worker só confirma a tarefa depois de receber confirmação da publicação terminal. Falhas antes desse ACK permitem reentrega e eventual cálculo repetido. API confirma o evento depois do commit no SQLite.

O primeiro resultado terminal aceito prevalece. Eventos terminais duplicados e processing atrasados não mudam esse estado. Estatísticas e histórico contam batalhas únicas; a distribuição por worker indica o resultado aceito, sem contar cálculos duplicados.

Mensagens inválidas são rejeitadas para descarte durável. Falhas de simulação com tarefa válida produzem failed e código seguro. Falhas de transporte causam reconexão/reentrega, com espera entre tentativas. A DLQ exige inspeção manual; não há replay automático de mensagens inválidas.

SIGTERM cancela novas entregas e dá até 25 segundos para trabalho em andamento; o Compose permite 35 segundos. Se a execução não terminar ou o processo morrer, a conexão fecha e mensagens não confirmadas retornam à fila. API fecha suas rotinas no lifespan; aplicar novamente um evento já gravado é seguro.

## Limitações deliberadas

- Uma réplica e um processo do Serviço A enquanto o armazenamento for SQLite local. Não escalar a API com arquivos de banco independentes.
- Persistência por volumes nomeados não é backup nem alta disponibilidade. Perder volumes, disco ou o host pode perder dados.
- Um broker sem replicação. Confirms e persistência protegem contra falhas normais de processo, sem prometer tolerância a qualquer falha de armazenamento.
- HTTP 202 não promete prazo de execução. Uma tarefa pode continuar pending/processing durante indisponibilidade; o painel indica tarefas ainda não publicadas.
- Classes não têm habilidades especiais, e empate é um resultado válido.
- Sem autenticação, cancelamento, exclusão de personagens ou atualização de atributos no MVP.
- O ambiente foi desenhado para demonstração acadêmica local, sem exposição pública.

## Referências

A implementação usa [publisher confirms e ACKs do RabbitMQ](https://www.rabbitmq.com/docs/confirms), [work queues do aio-pika](https://docs.aio-pika.com/rabbitmq-tutorial/2-work-queues.html) e [lifespan do FastAPI](https://fastapi.tiangolo.com/advanced/events/). O roteiro em demo.md mostra como observar as garantias na aplicação.
