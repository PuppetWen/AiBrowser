$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $root 'full-regression-elevated.log'
$stdoutPath = Join-Path $root 'full-regression-elevated.stdout.log'
$stderrPath = Join-Path $root 'full-regression-elevated.stderr.log'
$rgDirectory = 'C:\Users\puppet\AppData\Local\OpenAI\Codex\bin\3e42d49ad3e35a50'
$env:PATH = "$rgDirectory;$env:PATH"
$service = Get-Service -Name 'GameInputSvc'
$wasRunning = $service.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running
$testExitCode = 1

"[$(Get-Date -Format o)] elevated regression wrapper started" | Set-Content -LiteralPath $logPath -Encoding UTF8

try {
    if ($wasRunning) {
        "[$(Get-Date -Format o)] stopping GameInputSvc" | Add-Content -LiteralPath $logPath -Encoding UTF8
        Stop-Service -Name 'GameInputSvc' -Force
        (Get-Service -Name 'GameInputSvc').WaitForStatus(
            [System.ServiceProcess.ServiceControllerStatus]::Stopped,
            [TimeSpan]::FromSeconds(20)
        )
    }

    Set-Location -LiteralPath $root
    "[$(Get-Date -Format o)] starting Node full regression" | Add-Content -LiteralPath $logPath -Encoding UTF8
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $nodeProcess = Start-Process -FilePath $nodePath `
        -ArgumentList '.\_run-all-extra-selftests.js' `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -Wait `
        -PassThru
    $testExitCode = $nodeProcess.ExitCode
    "[$(Get-Date -Format o)] Node exit code: $testExitCode" | Add-Content -LiteralPath $logPath -Encoding UTF8
}
catch {
    "[$(Get-Date -Format o)] ERROR: $($_ | Out-String)" | Add-Content -LiteralPath $logPath -Encoding UTF8
    $testExitCode = 1
}
finally {
    if ($wasRunning) {
        "[$(Get-Date -Format o)] restoring GameInputSvc" | Add-Content -LiteralPath $logPath -Encoding UTF8
        Start-Service -Name 'GameInputSvc'
        (Get-Service -Name 'GameInputSvc').WaitForStatus(
            [System.ServiceProcess.ServiceControllerStatus]::Running,
            [TimeSpan]::FromSeconds(20)
        )
    }
    "[$(Get-Date -Format o)] wrapper finished" | Add-Content -LiteralPath $logPath -Encoding UTF8
}

exit $testExitCode
