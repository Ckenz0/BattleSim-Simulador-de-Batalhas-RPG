# Offline guardrails, not Kubernetes API schema validation or a cluster test.
$ErrorActionPreference = 'Stop'
function Assert-Manifest([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
foreach ($path in @($PSScriptRoot, (Join-Path $PSScriptRoot 'overlays/hpa-demo'))) {
    $rendered = (& kubectl kustomize $path) -join "`n"
    Assert-Manifest ($LASTEXITCODE -eq 0) "Kustomize falhou: $path"
    $objects = @{}
    foreach ($document in ($rendered -split '(?m)^---\s*$')) {
        $kind = [regex]::Match($document, '(?m)^kind: (\S+)').Groups[1].Value
        $name = [regex]::Match($document, '(?m)^  name: (\S+)').Groups[1].Value
        Assert-Manifest ([bool]$kind -and [bool]$name) 'Documento sem kind/name.'
        $objects["$kind/$name"] = $document
        Assert-Manifest ($kind -ne 'Secret') 'Credenciais nao devem entrar no manifesto renderizado.'
        if ($kind -ne 'Namespace') {
            Assert-Manifest ($document -match '(?m)^  namespace: battlesim$') "Namespace incorreto: $kind/$name"
        }
    }
    Assert-Manifest ($objects.Count -eq 12) 'Esperados 12 objetos.'
    $api = $objects['Deployment/service-a']
    Assert-Manifest ($api -match 'replicas: 1\s+selector:' -and $api -match 'type: Recreate') 'API precisa de uma replica e Recreate.'
    Assert-Manifest ($api -match 'claimName: api-data') 'API precisa do PVC SQLite.'
    Assert-Manifest ($api -match '/api/health/live' -and $api -match '/api/health/ready') 'Probes API ausentes.'
    Assert-Manifest ($objects['PersistentVolumeClaim/api-data'] -match 'ReadWriteOnce') 'PVC API ausente.'
    $worker = $objects['Deployment/service-b']
    Assert-Manifest ($worker -notmatch '(?m)^  replicas:') 'Deployment worker nao deve resetar o HPA.'
    Assert-Manifest ($worker -notmatch 'httpGet:|livenessProbe:|readinessProbe:') 'Worker nao possui endpoint de saude.'
    Assert-Manifest ($worker -match 'cpu: 250m') 'CPU request do worker incorreto.'
    foreach ($workload in @($api, $worker, $objects['Deployment/frontend'], $objects['StatefulSet/rabbitmq'])) {
        Assert-Manifest ([bool]$workload) 'Workload ausente.'
        Assert-Manifest ($workload -match 'requests:' -and $workload -match 'limits:') 'Workload sem requests/limits.'
        Assert-Manifest ($workload -match 'terminationGracePeriodSeconds:') 'Workload sem prazo de encerramento.'
    }
    $broker = $objects['StatefulSet/rabbitmq']
    Assert-Manifest ($broker -match 'volumeClaimTemplates:' -and $broker -match 'replicas: 1') 'RabbitMQ deve ter um Pod e PVC.'
    Assert-Manifest ($objects['Service/rabbitmq'] -match 'clusterIP: None') 'Service headless RabbitMQ ausente.'
    $hpa = $objects['HorizontalPodAutoscaler/service-b']
    Assert-Manifest ($hpa -match 'apiVersion: autoscaling/v2') 'HPA precisa de autoscaling/v2.'
    Assert-Manifest ($hpa -match 'minReplicas: 1' -and $hpa -match 'maxReplicas: 5') 'Limites HPA incorretos.'
    Assert-Manifest ($hpa -match 'name: cpu' -and $hpa -match 'averageUtilization: 60') 'Metrica CPU HPA incorreta.'
    Assert-Manifest ($objects['Ingress/battlesim'] -match 'ingressClassName: nginx' -and $objects['Ingress/battlesim'] -match 'name: frontend') 'Ingress deve encaminhar para frontend.'
    $config = @($objects.Keys | Where-Object { $_ -like 'ConfigMap/battlesim-config-*' })
    Assert-Manifest ($config.Count -eq 1) 'ConfigMap gerado ausente.'
    $configName = $config[0].Substring('ConfigMap/'.Length)
    Assert-Manifest ($api.Contains("name: $configName") -and $worker.Contains("name: $configName")) 'Referencias ConfigMap nao foram reescritas.'
    $iterations = if ($path -eq $PSScriptRoot) { '0' } else { '5000000' }
    Assert-Manifest ($objects[$config[0]] -match "WORKER_CPU_ITERATIONS: `"$iterations`"") 'Carga CPU incorreta.'
    Write-Output "PASS: $path (12 objetos, guardrails estaticos)."
}
$nginx = Get-Content (Join-Path $PSScriptRoot 'frontend-nginx.conf') -Raw
Assert-Manifest ($nginx -notmatch '(?m)^\s*resolver\s+127\.0\.0\.11') 'Resolver do Compose nao e valido no Kubernetes.'
Assert-Manifest ($nginx -match 'application/javascript mjs' -and $nginx -match 'X-Request-ID' -and $nginx -match 'Content-Security-Policy') 'MIME/trace/CSP ausentes.'
foreach ($scriptName in @('New-Secret.ps1', 'Invoke-Load.ps1', 'Test-Manifests.ps1')) {
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $scriptName), [ref]$null, [ref]$parseErrors) > $null
    Assert-Manifest ($parseErrors.Count -eq 0) "Erro de sintaxe: $scriptName"
}
Write-Output 'PASS: NGINX guardrails e sintaxe PowerShell. Nao valida schema da API nem comportamento de cluster.'
