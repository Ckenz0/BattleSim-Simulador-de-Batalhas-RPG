# Continuar em outro computador

## Obter o código

```bash
git clone https://github.com/Ckenz0/BattleSim-Simulador-de-Batalhas-RPG.git
cd BattleSim-Simulador-de-Batalhas-RPG
git switch feat/battlesim-mvp
```

## Executar com Docker Compose

Instale Docker Desktop com containers Linux ou Docker Engine com Compose v2. Crie a configuração local e escolha uma senha própria para o broker:

```powershell
Copy-Item .env.example .env
# Edite RABBITMQ_PASSWORD em .env antes de iniciar.
docker compose up --build -d --wait --wait-timeout 180
```

No Linux/macOS, use `cp .env.example .env`. Acesse **http://localhost:8080** ou a porta definida em `APP_PORT`. O frontend é montado diretamente de `frontend/`, portanto alterações nesses arquivos aparecem após recarregar a página.

Credenciais e volumes Docker não são transferidos pelo Git. A nova máquina começa com outra base de personagens, batalhas e aventuras. Os registros JSON em `docs/evidence/` são evidências históricas dos experimentos, não um backup do banco da aplicação.

## Desenvolvimento e testes

Para os testes locais, instale Python 3.11+, uv e Node.js. As dependências Python são resolvidas pelo `uv.lock`:

```powershell
uv sync --locked
uv run pytest -q
node --test tests/*.test.mjs
```

Os testes de preparação usam PowerShell e são desmarcados quando ele não está disponível. Testes de integração Docker são selecionados explicitamente com `uv run pytest -m integration -v`; eles interrompem componentes e criam registros reais.

## Kubernetes local

O cluster é configurado em cada máquina. Siga [k8s/local-setup.md](../k8s/local-setup.md) para criar o cluster Docker Desktop, construir as três imagens, instalar os addons e gerar um Secret novo. Selecione o perfil HPA conforme o [roteiro de validação](delivery-validation.md#selecionar-o-perfil-de-elasticidade).

Depois da primeira implantação:

```powershell
& ./scripts/Prepare-Presentation.ps1 -Start
```

Esse comando verifica os dois ambientes e abre o acesso local ao Ingress, mas não cria um cluster nem troca o perfil HPA. A Sala de Controle do Kubernetes fica em **http://localhost:8081/#control**. Consulte a [certificação técnica](technical-certification.md), o [guia da coleta](elasticity-presentation.md) e o [roteiro de demonstração](presentation-script.md).
