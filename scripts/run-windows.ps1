# Runs the one authoritative Countersign server on this Windows host and restarts it if it
# crashes. Logs go to data\logs. Stop with Ctrl+C (the server's lock file prevents a second copy).
#   powershell -ExecutionPolicy Bypass -File scripts\run-windows.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Test-Path .env)) { throw '.env is missing from the repository root' }
New-Item -ItemType Directory -Force data\logs | Out-Null
# Keep the laptop awake while this window runs (reverts when the process exits).
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[Win32.Power]::SetThreadExecutionState(0x80000001) | Out-Null  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
$restarts = 0
while ($true) {
  $log = "data\logs\server-$(Get-Date -Format yyyyMMdd).log"
  Write-Host "$(Get-Date -Format s) starting Countersign (restart #$restarts), log: $log"
  & node src/server.js *>> $log
  $code = $LASTEXITCODE
  if ($code -eq 0) { break }
  Write-Host "$(Get-Date -Format s) server exited with code $code"
  if (Select-String -Path $log -Pattern 'Another Countersign server|Refusing to listen' -Quiet) { Write-Host 'Not restarting: see the log.'; break }
  $restarts++
  Start-Sleep -Seconds ([Math]::Min(60, 5 * $restarts))
}
