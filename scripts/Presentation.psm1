# PowerShell 5.1 compatible. Reports contain fixed diagnostics, never raw tool errors.
function Invoke-PresentationCommand {
    param([string]$Command, [string[]]$Arguments = @(), [int]$TimeoutSeconds = 12, [string]$WorkingDirectory)
    $application = Get-Command $Command -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $application) { return [pscustomobject]@{ Ok = $false; Text = ''; TimedOut = $false } }
    $quoted = foreach ($argument in $Arguments) {
        if ($argument -notmatch '[\s"]') { $argument }
        else { '"' + (($argument -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
    }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $application.Source
    $info.Arguments = $quoted -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    if ($WorkingDirectory) { $info.WorkingDirectory = $WorkingDirectory }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit([Math]::Max(1, $TimeoutSeconds) * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            return [pscustomobject]@{ Ok = $false; Text = ''; TimedOut = $true }
        }
        return [pscustomobject]@{ Ok = ($process.ExitCode -eq 0); Text = $stdout.Result; TimedOut = $false }
    } catch {
        return [pscustomobject]@{ Ok = $false; Text = ''; TimedOut = $false }
    } finally { $process.Dispose() }
}

function Read-PresentationJson {
    param([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory)
    $result = Invoke-PresentationCommand -Command $Command -Arguments $Arguments -WorkingDirectory $WorkingDirectory
    if (-not $result.Ok) { return $null }
    try { return ($result.Text | ConvertFrom-Json -ErrorAction Stop) } catch { return $null }
}

function Read-PresentationHttp {
    param([string]$Uri)
    try { return Invoke-RestMethod -Uri $Uri -TimeoutSec 8 -ErrorAction Stop } catch { return $null }
}

function Get-PresentationComposeUrl {
    param($Services)
    $nginx = $Services | Where-Object { $_.Service -eq 'nginx' } | Select-Object -First 1
    $publisher = $nginx.Publishers | Where-Object {
        $_.TargetPort -eq 80 -and $_.Protocol -eq 'tcp' -and
        (Test-PresentationNumber $_.PublishedPort) -and $_.PublishedPort -ge 1 -and $_.PublishedPort -le 65535
    } | Select-Object -First 1
    if ($publisher) { return 'http://127.0.0.1:' + $publisher.PublishedPort }
    return 'http://127.0.0.1:8080'
}

function Get-PresentationSnapshot {
    param([string]$ProjectRoot)
    $state = [ordered]@{
        dockerInstalled = [bool](Get-Command docker -CommandType Application -ErrorAction SilentlyContinue)
        kubectlInstalled = [bool](Get-Command kubectl -CommandType Application -ErrorAction SilentlyContinue)
        engine = $false; composeServices = @(); nodes = @(); workloads = @(); pvcs = @()
        ingress = $null; controller = $null; hpa = $null; workerConfig = $null
        healthCompose = $null; healthCluster = $null; controlCompose = $null; controlCluster = $null; frontendModule = $false
        composeBaseUrl = 'http://127.0.0.1:8080'
    }
    if ($state.dockerInstalled) {
        $state.engine = (Invoke-PresentationCommand docker @('info', '--format', '{{.ServerVersion}}') -WorkingDirectory $ProjectRoot).Ok
    }
    if ($state.engine) {
        $compose = Invoke-PresentationCommand docker @('compose', 'ps', '--all', '--format', 'json') -WorkingDirectory $ProjectRoot
        if ($compose.Ok) {
            try {
                # Compose versions emit either one JSON array or newline-delimited objects.
                if ($compose.Text.TrimStart().StartsWith('[')) { $state.composeServices = @($compose.Text | ConvertFrom-Json) }
                else { $state.composeServices = @($compose.Text -split '\r?\n' | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json }) }
            } catch { $state.composeServices = @() }
        }
        $state.composeBaseUrl = Get-PresentationComposeUrl -Services $state.composeServices
        $state.healthCompose = Read-PresentationHttp ($state.composeBaseUrl + '/api/health/ready')
        $state.controlCompose = Read-PresentationHttp ($state.composeBaseUrl + '/api/control')
    }
    if ($state.kubectlInstalled) {
        $prefix = @('--context', 'docker-desktop', '--request-timeout=8s')
        $nodes = Read-PresentationJson kubectl ($prefix + @('get', 'nodes', '-o', 'json'))
        if ($nodes) {
            $state.nodes = @($nodes.items)
            $scope = $prefix + @('-n', 'battlesim')
            $workloads = Read-PresentationJson kubectl ($scope + @('get', 'deployment/service-a', 'deployment/service-b', 'deployment/frontend', 'statefulset/rabbitmq', '-o', 'json'))
            $state.workloads = @($workloads.items)
            $storage = Read-PresentationJson kubectl ($scope + @('get', 'pvc/api-data', 'pvc/data-rabbitmq-0', '-o', 'json'))
            $state.pvcs = @($storage.items)
            $state.ingress = Read-PresentationJson kubectl ($scope + @('get', 'ingress', 'battlesim', '-o', 'json'))
            $state.hpa = Read-PresentationJson kubectl ($scope + @('get', 'hpa', 'service-b', '-o', 'json'))
            $state.controller = Read-PresentationJson kubectl ($prefix + @('-n', 'nginx-ingress', 'get', 'deployment', 'nginx-ingress', '-o', 'json'))
            $worker = $state.workloads | Where-Object { $_.kind -eq 'Deployment' -and $_.metadata.name -eq 'service-b' } | Select-Object -First 1
            $container = $worker.spec.template.spec.containers | Where-Object { $_.name -eq 'worker' } | Select-Object -First 1
            $config = @{}
            foreach ($source in $container.envFrom) {
                if ($source.configMapRef.name) {
                    $map = Read-PresentationJson kubectl ($scope + @('get', 'configmap', $source.configMapRef.name, '-o', 'json'))
                    if ($map.data) { foreach ($entry in $map.data.PSObject.Properties) { $config[$entry.Name] = $entry.Value } }
                }
            }
            foreach ($entry in $container.env) { if ($null -ne $entry.value) { $config[$entry.name] = $entry.value } }
            $state.workerConfig = @{ cpuIterations = $config['WORKER_CPU_ITERATIONS']; concurrency = $config['WORKER_CONCURRENCY']; cpuRequest = $container.resources.requests.cpu }
            $state.healthCluster = Read-PresentationHttp 'http://localhost:8081/api/health/ready'
            $state.controlCluster = Read-PresentationHttp 'http://localhost:8081/api/control'
            try {
                $module = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:8081/js/experiment-view.mjs' -TimeoutSec 8 -ErrorAction Stop
                $state.frontendModule = $module.Content -match 'class ExperimentView'
            } catch { $state.frontendModule = $false }
        }
    }
    return [pscustomobject]$state
}

function Test-PresentationNumber($Value) {
    return ($Value -is [ValueType] -and $Value -isnot [bool] -and $Value -ge 0 -and -not [double]::IsNaN([double]$Value) -and -not [double]::IsInfinity([double]$Value))
}

function Test-PresentationWorkload($Workload) {
    if (-not $Workload -or -not (Test-PresentationNumber $Workload.spec.replicas) -or $Workload.spec.replicas -lt 1) { return $false }
    if ($Workload.kind -eq 'Deployment' -and $Workload.status.availableReplicas -lt $Workload.spec.replicas) { return $false }
    return ($Workload.status.observedGeneration -ge $Workload.metadata.generation -and
        $Workload.status.readyReplicas -ge $Workload.spec.replicas -and
        $Workload.status.updatedReplicas -ge $Workload.spec.replicas)
}

function Test-PresentationHealth($Health) {
    return ($Health.status -eq 'ok' -and $Health.database -eq $true -and $Health.broker_connected -eq $true)
}

function Test-PresentationDrained($Control) {
    if (-not $Control.application -or $Control.broker.status -ne 'ok') { return $false }
    foreach ($name in @('pending', 'processing', 'unpublished')) {
        $value = $Control.application.$name
        if (-not (Test-PresentationNumber $value) -or $value -ne 0) { return $false }
    }
    foreach ($name in @('battles.requests.v1', 'battles.events.v1')) {
        $queue = @($Control.broker.queues | Where-Object { $_.name -eq $name })
        if ($queue.Count -ne 1) { return $false }
        foreach ($field in @('ready', 'unacknowledged')) {
            if (-not (Test-PresentationNumber $queue[0].$field) -or $queue[0].$field -ne 0) { return $false }
        }
        if (-not (Test-PresentationNumber $queue[0].consumers) -or $queue[0].consumers -lt 1) { return $false }
    }
    return $true
}

function New-PresentationCheck($Id, $Name, [bool]$Passed, $Details, $Action) {
    [pscustomobject]@{ Id = $Id; Name = $Name; Status = $(if ($Passed) { 'PASS' } else { 'FAIL' }); Details = $(if ($Passed) { $Details } else { 'Requisito nao atendido; consulte a acao indicada.' }); Action = $(if ($Passed) { '' } else { $Action }) }
}

function Get-PresentationChecks {
    param($Snapshot)
    $s = $Snapshot
    New-PresentationCheck 'docker' 'Docker Engine' ($s.dockerInstalled -and $s.engine) 'Engine Linux acessivel.' 'Instale/inicie Docker Desktop; execute novamente com -Start.'
    $composeOk = $true
    foreach ($name in @('nginx', 'service-a', 'service-b', 'rabbitmq')) {
        $services = @($s.composeServices | Where-Object { $_.Service -eq $name })
        if (-not $services.Count) { $composeOk = $false }
        foreach ($service in $services) {
            if ($service.State -ne 'running' -or ($name -ne 'service-b' -and $service.Health -ne 'healthy')) { $composeOk = $false }
        }
    }
    New-PresentationCheck 'compose' 'Quatro servicos Compose' $composeOk 'Servicos ativos; healthchecks de entrada, API e broker.' 'Confira .env e use -Start; consulte docker compose ps e os logs locais se continuar indisponivel.'
    $nodesOk = @($s.nodes).Count -gt 0
    foreach ($node in $s.nodes) { if (-not @($node.status.conditions | Where-Object { $_.type -eq 'Ready' -and $_.status -eq 'True' }).Count) { $nodesOk = $false } }
    New-PresentationCheck 'nodes' 'No Kubernetes Ready' ($s.kubectlInstalled -and $nodesOk) 'Contexto explicito docker-desktop.' 'Ative o cluster Kubernetes do Docker Desktop conforme k8s/local-setup.md; aguarde o no Ready.'
    $workloadsOk = $true
    foreach ($name in @('service-a', 'service-b', 'frontend', 'rabbitmq')) {
        $workload = $s.workloads | Where-Object { $_.metadata.name -eq $name } | Select-Object -First 1
        if (-not (Test-PresentationWorkload $workload)) { $workloadsOk = $false }
    }
    New-PresentationCheck 'workloads' 'Workloads atualizados e prontos' $workloadsOk 'API, worker, frontend e RabbitMQ com replicas Ready.' 'Confira kubectl --context docker-desktop -n battlesim get pods e rollout status; use o setup se ainda nao implantou.'
    $storageOk = $true
    foreach ($name in @('api-data', 'data-rabbitmq-0')) {
        $pvc = $s.pvcs | Where-Object { $_.metadata.name -eq $name } | Select-Object -First 1
        if ($pvc.status.phase -ne 'Bound') { $storageOk = $false }
    }
    New-PresentationCheck 'storage' 'Volumes persistentes Bound' $storageOk 'PVCs da API e broker vinculados.' 'Investigue StorageClass/PVCs no setup local. Preserve os volumes existentes.'
    $hostOk = @($s.ingress.spec.rules | Where-Object { $_.host -eq 'localhost' }).Count -gt 0
    New-PresentationCheck 'ingress' 'Ingress NGINX local' ($hostOk -and $s.ingress.spec.ingressClassName -eq 'nginx' -and (Test-PresentationWorkload $s.controller)) 'Regra localhost e controller pronto.' 'Confira os addons e o overlay local em k8s/local-setup.md.'
    New-PresentationCheck 'http' 'APIs Compose e Ingress' ((Test-PresentationHealth $s.healthCompose) -and (Test-PresentationHealth $s.healthCluster)) 'Compose na porta publicada pelo NGINX e Ingress 8081, banco e broker prontos.' 'Use -Start para reabrir o Ingress. Se falhar, confira a porta publicada do Compose, DNS, broker e prontidao das APIs.'
    $cluster = $s.controlCluster.cluster
    $metricsOk = $cluster.status -eq 'ok' -and $cluster.metrics_status -eq 'ok' -and (Test-PresentationNumber $cluster.hpa.current_cpu_percent) -and @($cluster.pods).Count -gt 0
    foreach ($pod in $cluster.pods) {
        if (-not (Test-PresentationNumber $pod.cpu_cores) -or -not (Test-PresentationNumber $pod.memory_bytes)) { $metricsOk = $false }
    }
    New-PresentationCheck 'metrics' 'Metricas reais de CPU e memoria' $metricsOk 'API de metricas e leitura CPU do HPA disponiveis; zero medido e valido.' 'Aguarde o Metrics Server; confira kubectl --context docker-desktop -n battlesim top pods e docs/delivery-validation.md.'
    $cpuMetric = @($s.hpa.spec.metrics | Where-Object { $_.type -eq 'Resource' -and $_.resource.name -eq 'cpu' -and $_.resource.target.type -eq 'Utilization' -and $_.resource.target.averageUtilization -eq 60 })
    $hpaOk = $s.hpa.spec.minReplicas -eq 1 -and $s.hpa.spec.maxReplicas -eq 5 -and $cpuMetric.Count -gt 0 -and
        $s.hpa.spec.scaleTargetRef.name -eq 'service-b' -and $s.hpa.spec.scaleTargetRef.kind -eq 'Deployment' -and
        $s.workerConfig.cpuIterations -eq '5000000' -and $s.workerConfig.concurrency -eq '1' -and $s.workerConfig.cpuRequest -eq '250m'
    New-PresentationCheck 'hpa' 'Perfil de elasticidade 1 a 5' $hpaOk 'CPU alvo 60%, request 250m, carga 5000000 e concorrencia 1.' 'Selecione docker-desktop-hpa com fila drenada seguindo docs/delivery-validation.md. O script nao troca o perfil.'
    New-PresentationCheck 'queues' 'Filas e outbox drenadas' ((Test-PresentationDrained $s.controlCompose) -and (Test-PresentationDrained $s.controlCluster)) 'Zero pendentes, em processamento, sem ACK e aguardando publicacao; consumidores conectados.' 'Aguarde as cargas terminarem. Confira workers, broker e /api/control nos dois ambientes; dados ausentes nao significam zero.'
    $baseline = $cluster.status -eq 'ok' -and $cluster.hpa.current_replicas -eq 1 -and $cluster.hpa.desired_replicas -eq 1 -and $cluster.ready_workers -eq 1
    New-PresentationCheck 'baseline' 'Linha de base de um worker' $baseline 'Uma replica atual, desejada e pronta antes da carga.' 'Aguarde a reducao automatica do HPA antes de iniciar nova coleta; nao altere replicas durante o ensaio.'
    New-PresentationCheck 'frontend' 'Historico visual publicado' ([bool]$s.frontendModule) 'Modulo da coleta servido pelo Ingress.' 'Atualize o frontend para presentation-v1 conforme docs/elasticity-presentation.md e recarregue a pagina.'
}

function Start-PresentationServices {
    param([string]$ProjectRoot, [int]$TimeoutSeconds = 180)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $engine = Invoke-PresentationCommand docker @('info', '--format', '{{.ServerVersion}}')
    if (-not $engine.Ok) {
        Write-Host 'Iniciando Docker Desktop...'
        $started = Invoke-PresentationCommand docker @('desktop', 'start', '--timeout', [string]$TimeoutSeconds) -TimeoutSeconds $TimeoutSeconds
        if (-not $started.Ok) { Write-Host 'Docker Desktop nao ficou pronto. A checagem final indicara a recuperacao.'; return }
    }
    $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalSeconds)
    Write-Host 'Preparando Compose com os dados existentes...'
    $compose = Invoke-PresentationCommand docker @('compose', 'up', '-d', '--wait', '--wait-timeout', [string]$remaining) -TimeoutSeconds $remaining -WorkingDirectory $ProjectRoot
    if (-not $compose.Ok) { Write-Host 'Compose ainda indisponivel; confira o resultado da checagem.' }
    if (-not (Get-Command kubectl -CommandType Application -ErrorAction SilentlyContinue)) { return }
    do {
        $nodes = Invoke-PresentationCommand kubectl @('--context', 'docker-desktop', '--request-timeout=5s', 'get', 'nodes', '-o', 'name') -TimeoutSeconds 6
        if ($nodes.Ok) { break }
        if ([DateTime]::UtcNow -ge $deadline) { Write-Host 'Cluster ainda indisponivel; ative-o no Docker Desktop.'; return }
        Start-Sleep -Seconds 2
    } while ($true)
    Write-Host 'Aguardando prontidao dos workloads existentes...'
    foreach ($workload in @('statefulset/rabbitmq', 'deployment/service-a', 'deployment/service-b', 'deployment/frontend')) {
        $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalSeconds)
        $null = Invoke-PresentationCommand kubectl @('--context', 'docker-desktop', '--request-timeout=8s', '-n', 'battlesim', 'rollout', 'status', $workload, "--timeout=${remaining}s") -TimeoutSeconds $remaining
    }
    $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalSeconds)
    $null = Invoke-PresentationCommand kubectl @('--context', 'docker-desktop', '--request-timeout=8s', 'wait', '--for=condition=Available', 'apiservice/v1beta1.metrics.k8s.io', "--timeout=${remaining}s") -TimeoutSeconds $remaining
    $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalSeconds)
    $shellPath = (Get-Process -Id $PID).Path
    $requestTimeout = [string][Math]::Min(8, $remaining)
    $forward = Invoke-PresentationCommand -Command $shellPath -Arguments @('-NoProfile', '-NonInteractive', '-File',
        (Join-Path $ProjectRoot 'k8s/Start-LocalIngress.ps1'), '-RequestTimeoutSeconds', $requestTimeout) -TimeoutSeconds $remaining -WorkingDirectory $ProjectRoot
    if (-not $forward.Ok) { Write-Host 'Acesso Ingress nao iniciado no prazo. Confira a porta 8081 e o setup local.' }
}

Export-ModuleMember -Function Invoke-PresentationCommand, Get-PresentationSnapshot, Get-PresentationChecks, Start-PresentationServices, Get-PresentationComposeUrl
