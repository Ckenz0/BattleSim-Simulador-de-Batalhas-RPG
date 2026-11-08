# Segunda e terceira etapas: Kubernetes e HPA

Os manifestos completos ficam para a próxima entrega, conforme o escopo aprovado. O MVP já tem workers independentes, contratos por broker, carga CPU configurável e IDs que não dependem de uma instância fixa.

## Recursos previstos

- Deployment do Serviço A com **uma réplica**, um processo e volume persistente para SQLite. Estratégia de atualização Recreate ou outra que impeça escrita concorrente por Pods distintos; não usar HPA na API nesta etapa.
- Deployment do Serviço B com múltiplas réplicas, mesmo contrato de tarefas e prefetch 1. Não precisa de Service HTTP porque não oferece esse protocolo.
- Serviços internos para API e RabbitMQ; frontend servido por um componente HTTP atrás do NGINX Ingress Controller. O Ingress não hospeda os arquivos estáticos por si só.
- RabbitMQ com persistência e identidade estável, preferencialmente StatefulSet e PVC. Uma instância é suficiente no escopo didático, com limitações documentadas.
- ConfigMaps para configuração não secreta; Secrets para credenciais. Não publicar valores reais no Git.
- Requests e limits de CPU/memória, probes de liveness/readiness apropriadas e prazo de encerramento compatível com o worker.
- Metrics Server funcional e HorizontalPodAutoscaler autoscaling/v2 no Serviço B, usando CPU como métrica obrigatória. Proposta inicial: minReplicas 1, maxReplicas 5 e alvo de utilização de CPU de 60%; validar recursos no cluster e registrar os valores efetivos.

## Experimentos exigidos

1. Publicar tarefas por um único ponto de entrada e rastrear uma operação pelos logs.
2. Executar pelo menos duas réplicas do worker; remover um Pod e observar o Deployment repor a réplica.
3. Alterar manualmente a quantidade de workers e observar compartilhamento da fila.
4. Habilitar HPA, gerar um lote sustentado com WORKER_CPU_ITERATIONS configurado e observar subida do uso de CPU e das réplicas.
5. Encerrar a geração de carga e observar redução gradual conforme as janelas de estabilização.
6. Documentar resultados e distinguir escala manual de elasticidade automática.

CPU é a métrica obrigatória. Escala por tamanho de fila é uma melhoria futura que exigirá integração adicional, fora do mínimo. Para escalar o Serviço A no futuro, substituir SQLite por armazenamento compartilhado adequado e rever a concorrência/publicação da outbox.
