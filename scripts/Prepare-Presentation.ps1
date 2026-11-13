#Requires -Version 5.1
[CmdletBinding()]
param([switch]$Start, [ValidateRange(15, 600)][int]$TimeoutSeconds = 180, [string]$ReportPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $PSScriptRoot 'Presentation.psm1') -Force

if ($Start) { Start-PresentationServices -ProjectRoot $projectRoot -TimeoutSeconds $TimeoutSeconds }
$snapshot = Get-PresentationSnapshot -ProjectRoot $projectRoot
$checks = @(Get-PresentationChecks -Snapshot $snapshot)
$failed = @($checks | Where-Object { $_.Status -eq 'FAIL' })
$report = [ordered]@{
    schema_version = 1
    observed_at = [DateTime]::UtcNow.ToString('o')
    ready = ($failed.Count -eq 0)
    context = 'docker-desktop'
    startup_requested = [bool]$Start
    urls = @(($snapshot.composeBaseUrl + '/#control'), 'http://localhost:8081/#control')
    checks = $checks
}
if (-not $ReportPath) {
    $git = Invoke-PresentationCommand git @('-C', $projectRoot, 'rev-parse', '--absolute-git-dir')
    if (-not $git.Ok) { throw 'Nao foi possivel localizar o diretorio Git. Informe -ReportPath.' }
    $ReportPath = Join-Path $git.Text.Trim() 'presentation-readiness.json'
}
$absoluteReport = [IO.Path]::GetFullPath($ReportPath)
$null = New-Item -ItemType Directory -Path (Split-Path $absoluteReport -Parent) -Force
[IO.File]::WriteAllText($absoluteReport, ($report | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
$checks | Select-Object Status, Name | Format-Table -AutoSize | Out-Host
Write-Host "Relatorio: $absoluteReport"
if ($failed.Count) {
    foreach ($check in $failed) { Write-Host ("[{0}] {1}" -f $check.Name, $check.Action) }
    Write-Host 'Ambiente ainda nao esta pronto para a apresentacao.'
    exit 1
}
Write-Host 'Pronto para apresentar: http://localhost:8081/#control'
Write-Host 'Roteiro do grupo: docs/presentation-script.md'
exit 0
