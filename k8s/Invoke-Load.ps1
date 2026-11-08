# Sends ordinary battles through the public API; no direct broker/DB access.
[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://127.0.0.1:8081',
    [ValidateRange(30, 3600)][int]$DurationSeconds = 600,
    [ValidateRange(5, 200)][int]$TargetBacklog = 50,
    [ValidateRange(1, 100)][int]$BatchSize = 25
)
$ErrorActionPreference = 'Stop'
$BaseUrl = $BaseUrl.TrimEnd('/')
function Invoke-Api([string]$Method, [string]$Path, $Payload = $null) {
    $request = @{
        Uri = "$BaseUrl$Path"; Method = $Method; TimeoutSec = 30
        Headers = @{ 'X-Request-ID' = $script:traceId }
    }
    if ($null -ne $Payload) {
        $request.ContentType = 'application/json'
        $request.Body = $Payload | ConvertTo-Json -Compress
    }
    Invoke-RestMethod @request
}
$script:traceId = 'hpa-' + [Guid]::NewGuid().ToString('N')
$health = Invoke-Api GET '/api/health/ready'
if ($health.status -ne 'ok') { throw 'API indisponivel.' }
$participants = @()
foreach ($suffix in @('A', 'B')) {
    $participants += Invoke-Api POST '/api/characters' @{
        name = "$script:traceId-$suffix"; class_name = 'warrior'
        hp = 145; attack = 34; defense = 22; speed = 35
    }
}
$clock = [Diagnostics.Stopwatch]::StartNew()
$submitted = 0
Write-Output "request_id=$script:traceId duration_seconds=$DurationSeconds target_backlog=$TargetBacklog"
try {
    while ($clock.Elapsed.TotalSeconds -lt $DurationSeconds) {
        $stats = Invoke-Api GET '/api/stats'
        $backlog = [int]$stats.pending + [int]$stats.processing
        $count = [Math]::Min($BatchSize, [Math]::Max(0, $TargetBacklog - $backlog))
        if ($count -gt 0) {
            $batch = Invoke-Api POST '/api/battles/batch' @{
                character_a_id = $participants[0].id
                character_b_id = $participants[1].id
                count = $count
            }
            $submitted += $count
            Write-Output ("elapsed={0}s batch_id={1} submitted={2} backlog_before={3}" -f [int]$clock.Elapsed.TotalSeconds, $batch.batch_id, $submitted, $backlog)
        }
        Start-Sleep -Seconds 2
    }
} finally {
    $clock.Stop()
    Write-Output "Geracao encerrada. submitted=$submitted request_id=$script:traceId. Aguarde a fila esvaziar antes de medir a reducao do HPA."
}
