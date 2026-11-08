# Creates credentials directly in the selected cluster; does not print or save them.
# Invoke only after selecting the intended context and creating namespace battlesim.
[CmdletBinding()]
param([string]$Namespace = 'battlesim')
$ErrorActionPreference = 'Stop'
$context = & kubectl config current-context
if ($LASTEXITCODE -ne 0 -or -not $context) { throw 'Selecione um contexto Kubernetes antes de criar o Secret.' }
# Refuse rotation: RabbitMQ only uses DEFAULT_USER/PASS when its data volume is new.
$existing = & kubectl -n $Namespace get secret battlesim-rabbitmq --ignore-not-found -o name
if ($LASTEXITCODE -ne 0) { throw 'Falha ao consultar o Secret; nada foi alterado.' }
if ($existing) { throw 'O Secret ja existe; preserve-o para manter acesso ao volume RabbitMQ existente.' }
$credentialBytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($credentialBytes)
    $password = ([BitConverter]::ToString($credentialBytes)).Replace('-', '').ToLowerInvariant()
    $secret = @{
        apiVersion = 'v1'; kind = 'Secret'; type = 'Opaque'
        metadata = @{ name = 'battlesim-rabbitmq'; namespace = $Namespace }
        stringData = @{ username = 'battlesim'; password = $password }
    }
    # stdin keeps credentials out of process arguments, local files and console output.
    $secret | ConvertTo-Json -Depth 5 -Compress | & kubectl create -f -
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o Secret.' }
} finally {
    [Array]::Clear($credentialBytes, 0, $credentialBytes.Length)
    $rng.Dispose()
    $password = $null
    $secret = $null
}
