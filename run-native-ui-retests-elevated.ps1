$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$service = Get-Service -Name 'GameInputSvc'
$wasRunning = $service.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running
$testExitCode = 1

try {
    if ($wasRunning) {
        Stop-Service -Name 'GameInputSvc' -Force
        (Get-Service -Name 'GameInputSvc').WaitForStatus(
            [System.ServiceProcess.ServiceControllerStatus]::Stopped,
            [TimeSpan]::FromSeconds(20)
        )
    }

    Set-Location -LiteralPath $root
    & node '.\run-native-ui-retests.js'
    $testExitCode = $LASTEXITCODE
}
finally {
    if ($wasRunning) {
        Start-Service -Name 'GameInputSvc'
        (Get-Service -Name 'GameInputSvc').WaitForStatus(
            [System.ServiceProcess.ServiceControllerStatus]::Running,
            [TimeSpan]::FromSeconds(20)
        )
    }
}

exit $testExitCode
