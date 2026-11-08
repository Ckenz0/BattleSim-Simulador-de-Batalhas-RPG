# Visão de evolução do BattleSim

A referência visual enviada pelo usuário orienta um RPG 2D com personagens chibi expressivos, cenário colorido, molduras roxas/creme, narração dos ataques e uma conclusão celebrando a vitória.

## Base visual desta entrega

Arena diagonal com aliado de costas e adversário de frente. Sprites originais de Guerreiro, Mago e Arqueiro, poses de ataque/impacto, efeitos de espada, magia e flecha, dano e vida sincronizados, controles de reprodução e tela de vitória. Continua sendo uma simulação assíncrona de dois personagens. Classes nesta etapa mantêm as regras já existentes; os nomes dos golpes descrevem sua animação.

O cenário e os personagens são PNGs locais gerados pelo imagegen integrado. Os prompts completos estão em frontend/assets/art-provenance.json e embutidos nos PNGs. A interface e seus controles continuam em HTML/CSS/JavaScript, não rasterizados.

## Caminho para a visão completa

| Evolução | Comportamento pretendido | Trabalho necessário |
| --- | --- | --- |
| Quatro classes com identidade mecânica | Guerreiro, Mago, Clérigo e Arqueiro com habilidades distintas | Definir cura, custos e defesa; versionar contratos e testar balanceamento |
| Catálogo de inimigos | Slime, Goblin, Esqueleto, Morcego, Aranha, Orc, Lobisomem e Fantasma | Sprites/poses, atributos e comportamento por tipo |
| Equipes e formação | Vários integrantes enfrentando um ou mais inimigos | Novo motor com seleção de alvo, iniciativa e eventos de cura/dano |
| Progressão persistida | Experiência, níveis e evolução de atributos | Regras reproduzíveis e atualização idempotente, sem conceder XP duas vezes por reentrega |
| Quatro regiões e chefes | Floresta, deserto, montanha e castelo; chefes associados | Cenários, encontros, desbloqueios e mapa de progresso |
| Comandos de combate | Atacar, habilidade, defender, item e fugir com efeitos reais | Definir modo automático e modo com decisões do jogador; comandos também atravessam o broker |

Essas linhas são o roteiro do produto, não funcionalidades já disponíveis. A referência sugere quatro chefes: Rei Goblin, Dragão Jovem, Necromante e Rainha Aranha. Números de níveis, recompensas e equilíbrio serão definidos quando cada camada entrar em desenvolvimento.

## Arquitetura da disciplina

A evolução do jogo mantém a separação entre API e worker por RabbitMQ, snapshots nas mensagens e idempotência dos resultados. A tarefa computacional continua funcionando sem depender da duração da animação no navegador. Reproduzir uma luta não solicita nova simulação.

Kubernetes, recuperação de Pods e HPA de CPU seguem como entregas de infraestrutura previstas em k8s/README.md. Ampliar o domínio não substitui essas demonstrações da disciplina.
