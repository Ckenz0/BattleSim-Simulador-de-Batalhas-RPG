# Persistent, loopback-only access through the actual NGINX Ingress Controller.
[CmdletBinding()]
param([ValidateRange(1024, 65535)][int]$Port = 8081, [ValidateRange(1, 60)][int]$RequestTimeoutSeconds = 8)
$ErrorActionPreference = 'Stop'
$kubectlCommand = (Get-Command kubectl).Source
# Windows network compartments can hide kubectl's listeners from Get-NetTCPConnection.
# Match the actual process/arguments before relying on the default TCP table.
$ownedForwards = @(Get-CimInstance Win32_Process -Filter "Name = 'kubectl.exe'" | Where-Object {
    $_.ExecutablePath -eq $kubectlCommand -and
    $_.CommandLine -match '--context\s+docker-desktop(?:\s|$)' -and
    $_.CommandLine -match '-n\s+nginx-ingress(?:\s|$)' -and
    $_.CommandLine -match "port-forward\s+service/nginx-ingress\s+${Port}:80(?:\s|$)" -and
    $_.CommandLine -match '--address=127\.0\.0\.1,::1(?:\s|$)'
})
if ($ownedForwards.Count -gt 0) {
    Write-Output "Port-forward do Ingress ja esta em execucao em http://localhost:$Port (PID $($ownedForwards[0].ProcessId))."
    return
}
$existing = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
    # A matching forward was already handled above. Never adopt an ambiguous one.
    throw "Porta $Port ocupada por outro processo ou encaminhamento. Use -Port com uma porta livre."
}
& $kubectlCommand --context docker-desktop "--request-timeout=${RequestTimeoutSeconds}s" -n nginx-ingress get service nginx-ingress -o name
if ($LASTEXITCODE -ne 0) { throw 'O controller NGINX precisa estar instalado no contexto docker-desktop.' }
$gitDirectory = & git -C (Split-Path $PSScriptRoot -Parent) rev-parse --absolute-git-dir
if ($LASTEXITCODE -ne 0) { throw 'Execute a partir de um checkout Git do BattleSim.' }
$logDirectory = Join-Path $gitDirectory 'local-cluster'
New-Item -ItemType Directory -Path $logDirectory -Force > $null
$forward = Start-Process -FilePath $kubectlCommand -ArgumentList @(
    '--context', 'docker-desktop', '-n', 'nginx-ingress', 'port-forward',
    'service/nginx-ingress', "${Port}:80", '--address=127.0.0.1,::1'
) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory "ingress-$Port.out.log") `
  -RedirectStandardError (Join-Path $logDirectory "ingress-$Port.err.log") -PassThru
Start-Sleep -Seconds 1
$forward.Refresh()
if ($forward.HasExited) { throw "Port-forward terminou; consulte os logs locais em $logDirectory." }
$forward.Id | Set-Content (Join-Path $logDirectory "ingress-$Port.pid")
Write-Output "Ingress em http://localhost:$Port (PID $($forward.Id)). Reinicie este script apos reiniciar o cluster/controller."
