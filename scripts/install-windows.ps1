[CmdletBinding()]
param(
    [ValidateSet('Stage','Install')][string]$Mode = 'Stage',
    [Parameter(Mandatory=$true)][string]$BundlePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
    [Parameter(Mandatory=$true)][string]$BootstrapPath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$BootstrapSha256,
    [Parameter(Mandatory=$true)][string]$HarnessPath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$HarnessSha256,
    [string]$NodePath = "$env:APPDATA\fnm\node-versions\v24.14.0\installation\node.exe",
    [string]$ExpectedComputerName = 'TB14P-EZRA',
    [string]$ExpectedIdentity = 'TB14P-EZRA\ezra',
    [string]$ExpectedRelayUrl = 'https://relay.cyjin.dev',
    [string]$ManifestUrl = 'https://relay.cyjin.dev/updates/device/stable.json',
    [string]$RelayRoot = $env:USERPROFILE,
    [string]$ConfigPath = "$env:USERPROFILE\.mcp-relay\device.json",
    [string]$InstallRoot = "$env:USERPROFILE\.mcp-relay\managed",
    [string]$LegacyEntryPoint = "$env:USERPROFILE\AppData\Local\npm-cache\_npx\71175ae0e040d800\node_modules\@cyjin\mcp-relay\dist\cli.cjs",
    [string]$TaskName = 'MyDevices-McpRelay-ezra',
    [string]$Packs = 'minimal,omp',
    [switch]$AllowKernel,
    [ValidateRange(10,86400)][int]$UpdateIntervalSeconds = 300,
    [ValidateRange(20,180)][int]$HealthTimeoutSeconds = 90,
    [string]$AcceptanceReceipt,
    [Parameter(Mandatory=$true)][string]$ReceiptPath,
    [switch]$RequireOtaProof
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$administrator = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$mutex = $null
$ownsMutex = $false
$journal = $null
$transactionStarted = $false
$taskRegistered = $false
$legacyStopped = $false
$bootstrapEntry = Join-Path $InstallRoot 'bootstrap.cjs'
$journalPath = Join-Path $InstallRoot 'install-journal.json'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$report = [ordered]@{
    schemaVersion=1; mode=$Mode; passed=$false; phase='validating'
    computerName=$env:COMPUTERNAME; identity=$identity.Name; administrator=$administrator
    startedAt=[DateTime]::UtcNow.ToString('o')
}
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Canonical([string]$Path) { return [IO.Path]::GetFullPath($Path).TrimEnd('\','/').ToLowerInvariant() }
function Ps-Quote([string]$Value) { return "'" + $Value.Replace("'","''") + "'" }
function Save-Json([string]$Path, $Object) {
    [IO.Directory]::CreateDirectory((Split-Path -Parent ([IO.Path]::GetFullPath($Path)))) | Out-Null
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, ($Object | ConvertTo-Json -Depth 15), (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path) {
        [IO.File]::Replace($temporary, $Path, ($Path + '.previous-' + [Guid]::NewGuid().ToString('N')))
    } else { [IO.File]::Move($temporary,$Path) }
}
function Copy-Verified([string]$Source,[string]$Destination,[string]$Digest) {
    if ((Hash $Source) -ne $Digest.ToLowerInvariant()) { throw 'A source artifact failed its SHA-256 check' }
    if (Test-Path -LiteralPath $Destination) {
        if ((Hash $Destination) -ne $Digest.ToLowerInvariant()) { throw ('Preserved artifact conflicts with the requested digest: ' + $Destination) }
        return
    }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Destination)) | Out-Null
    $temporary = $Destination + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::Copy($Source,$temporary,$false)
    if ((Hash $temporary) -ne $Digest.ToLowerInvariant()) { throw 'Copied artifact failed its SHA-256 check' }
    [IO.File]::Move($temporary,$Destination)
}
function Existing-Task {
    return Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction SilentlyContinue
}
function Managed-Task($Task) {
    if ($null -eq $Task) { return $false }
    return ([string]$Task.Description).StartsWith('My Devices relay managed by install-windows.ps1')
}
function Argument-Value([string]$CommandLine,[string]$Flag) {
    $pattern = '(?:^|\s)' + [regex]::Escape($Flag) + '(?:=|\s+)(?:"([^"]*)"|(\S+))'
    $match = [regex]::Match($CommandLine,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) { return $null }
    if ($match.Groups[1].Success) { return $match.Groups[1].Value }
    return $match.Groups[2].Value
}
function Owned-RelayProcesses {
    $found = @()
    $updatesRoot = Join-Path (Split-Path -Parent $ConfigPath) 'updates'
    foreach ($item in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")) {
        $command = [string]$item.CommandLine
        if ([string]::IsNullOrWhiteSpace($command) -or $command -notmatch '(?:^|\s)"?connect"?(?:\s|$)') { continue }
        $legacy = $command.IndexOf($LegacyEntryPoint,[StringComparison]::OrdinalIgnoreCase) -ge 0
        $legacyEntry = $LegacyEntryPoint
        $recoveryPattern = [regex]::Escape($InstallRoot) + '[\\/]backups[\\/][^"\s]+[\\/]previous-cli\.cjs'
        $recoveryMatch = [regex]::Match($command,$recoveryPattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($recoveryMatch.Success) { $legacy=$true; $legacyEntry=$recoveryMatch.Value }
        $managed = $command.IndexOf($bootstrapEntry,[StringComparison]::OrdinalIgnoreCase) -ge 0
        $givenConfig = Argument-Value $command '--config'
        if (-not $managed -and $givenConfig -and $command.IndexOf($updatesRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $command -match 'cli\.cjs') { $managed = $true }
        $packageKnown = $command.IndexOf('\@cyjin\mcp-relay\',[StringComparison]::OrdinalIgnoreCase) -ge 0
        if (-not $legacy -and -not $managed -and -not $packageKnown) { continue }
        if ($givenConfig) {
            if (-not [IO.Path]::IsPathRooted($givenConfig)) { $givenConfig = Join-Path $RelayRoot $givenConfig }
            if ((Canonical $givenConfig) -ne (Canonical $ConfigPath)) { continue }
        } elseif ($managed) { continue }
        $givenRoot = Argument-Value $command '--root'
        if ($givenRoot) {
            if (-not [IO.Path]::IsPathRooted($givenRoot)) { $givenRoot = Join-Path $RelayRoot $givenRoot }
            if ((Canonical $givenRoot) -ne (Canonical $RelayRoot)) { continue }
        }
        if (-not $legacy -and -not $managed) { throw 'A relay uses an unexpected package entry; provide its verified LegacyEntryPoint instead of stopping it by name' }
        $owner = Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid
        if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $identity.User.Value) { throw 'A matching relay process is not verifiably owned by the current Windows identity' }
        $found += [pscustomobject]@{ Id=[int]$item.ProcessId; ParentId=[int]$item.ParentProcessId; Legacy=$legacy; Managed=$managed; Entry=$legacyEntry }
    }
    return $found
}
function Read-Status {
    $raw = @(& $NodePath $bootstrapEntry update-status --config $ConfigPath 2>$null)
    if ($LASTEXITCODE -ne 0) { return $null }
    try { return (($raw -join [Environment]::NewLine) | ConvertFrom-Json) } catch { return $null }
}
function Wait-NoManaged([int]$Seconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        if (@(Owned-RelayProcesses | Where-Object { $_.Managed }).Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Managed relay processes are still exiting; no legacy process was restarted and no unrelated process was killed'
}
function Node-Invocation([string]$Entry,[string[]]$Arguments,[string]$LogPath) {
    $array = @($Entry) + $Arguments
    $items = @($array | ForEach-Object { Ps-Quote $_ }) -join ','
    return @(
        '$ErrorActionPreference = ''Stop'''
        '$env:MCP_RELAY_WORKER = ''0'''
        '$env:MCP_RELAY_SUPERVISOR = ''0'''
        '$env:MCP_RELAY_LAUNCHED = ''0'''
        '$env:MCP_RELAY_START_DRAINED = ''0'''
        ('Set-Location -LiteralPath ' + (Ps-Quote $RelayRoot))
        ('& ' + (Ps-Quote $NodePath) + ' @(' + $items + ') *>> ' + (Ps-Quote $LogPath))
        'exit $LASTEXITCODE'
    ) -join [Environment]::NewLine
}
function Restore-Previous($Saved) {
    if ($Saved.computerName -ine $ExpectedComputerName -or $Saved.identity -ine $identity.Name) { throw 'Recovery journal identity mismatch' }
    $currentTask = Existing-Task
    if ($null -ne $currentTask -and (Managed-Task $currentTask)) {
        Stop-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    Wait-NoManaged 20
    if ((Hash $ConfigPath) -ne $Saved.configSha256) { throw 'Device configuration changed during deployment; recovery stopped without overwriting credentials' }
    if ($Saved.taskWasPresent) {
        if (-not (Test-Path -LiteralPath $Saved.taskBackup -PathType Leaf) -or (Hash $Saved.taskBackup) -ne $Saved.taskBackupSha256) { throw 'Previous task backup failed integrity verification' }
        Register-ScheduledTask -TaskPath '\' -TaskName $TaskName -Xml ([IO.File]::ReadAllText($Saved.taskBackup)) -Force | Out-Null
        if ($Saved.taskWasRunning) { Start-ScheduledTask -TaskPath '\' -TaskName $TaskName }
    } elseif ($null -ne $currentTask -and (Managed-Task $currentTask)) {
        Unregister-ScheduledTask -TaskPath '\' -TaskName $TaskName -Confirm:$false
    }
    if ($Saved.legacyWasRunning -and -not $Saved.taskWasRunning -and @(Owned-RelayProcesses | Where-Object { $_.Legacy }).Count -eq 0) {
        if ((Hash $Saved.legacyRestoreEntryPoint) -ne $Saved.legacySha256) { throw 'Previous relay entry failed integrity verification' }
        $restoreCode = Node-Invocation $Saved.legacyRestoreEntryPoint @($Saved.legacyArgs) (Join-Path $InstallRoot 'rollback.log')
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($restoreCode))
        Start-Process -FilePath $windowsPowerShell -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',$encoded) -WorkingDirectory $RelayRoot -WindowStyle Hidden | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while (@(Owned-RelayProcesses | Where-Object { $_.Legacy }).Count -eq 0) {
            if ([DateTime]::UtcNow -gt $deadline) { throw 'Previous relay restart was not observed; recovery evidence was retained' }
            Start-Sleep -Milliseconds 250
        }
    }
}
try {
    if ($env:COMPUTERNAME -ine $ExpectedComputerName -or $identity.Name -ine $ExpectedIdentity) { throw 'Unexpected Windows computer or account identity; deployment stopped' }
    if ($NodePath -match '[\\/]fnm_multishells[\\/]') { throw 'Use a stable Node executable, not a temporary fnm multishell entry' }
    foreach ($path in @($NodePath,$BundlePath,$BootstrapPath,$HarnessPath,$ConfigPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('Required file is unavailable: ' + $path) }
    }
    if (-not (Test-Path -LiteralPath $RelayRoot -PathType Container)) { throw 'Configured relay root is unavailable' }
    $relayUri = [Uri]$ExpectedRelayUrl
    $manifestUri = [Uri]$ManifestUrl
    if ($relayUri.Scheme -ne 'https' -or $manifestUri.Scheme -ne 'https' -or $manifestUri.Authority -ine $relayUri.Authority -or $manifestUri.UserInfo) { throw 'Release channel must use HTTPS on the expected relay origin' }
    try { $config = ([IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json) } catch { throw 'Saved device configuration could not be parsed' }
    if (([string]$config.url).TrimEnd('/') -ine $ExpectedRelayUrl.TrimEnd('/') -or [string]::IsNullOrWhiteSpace([string]$config.token)) { throw 'Saved device configuration does not belong to the expected relay' }
    $configHash = Hash $ConfigPath
    $deviceName = if ($config.PSObject.Properties.Name -contains 'name') { [string]$config.name } else { $ExpectedComputerName }
    if ([string]::IsNullOrWhiteSpace($deviceName)) { $deviceName = $ExpectedComputerName }
    $nodeVersion = (@(& $NodePath --version) -join '').Trim().TrimStart('v')
    if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.5.0') { throw 'Node 22.5 or newer is required' }
    if ($Packs -notmatch '^(minimal|omp|kernel)(,(minimal|omp|kernel))*$' -or ($Packs -match 'kernel' -and -not $AllowKernel)) { throw 'Requested packs or kernel authorization are invalid' }
    $mutexKey = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes((Canonical $ConfigPath)))).Replace('-','').Substring(0,20)
    $mutex = New-Object Threading.Mutex($false,('Global\MyDevicesRelayInstall-' + $mutexKey))
    try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another installer already owns this device configuration' }
    $stage = Join-Path $InstallRoot ('staged\' + $ExpectedSha256.ToLowerInvariant())
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    $candidate = Join-Path $stage 'candidate.cjs'
    $stagedBootstrap = Join-Path $stage ('bootstrap-' + $BootstrapSha256.ToLowerInvariant() + '.cjs')
    $harness = Join-Path $stage ('acceptance-' + $HarnessSha256.ToLowerInvariant() + '.cjs')
    Copy-Verified $BundlePath $candidate $ExpectedSha256
    Copy-Verified $BootstrapPath $stagedBootstrap $BootstrapSha256
    Copy-Verified $HarnessPath $harness $HarnessSha256
    & $NodePath --check $candidate
    if ($LASTEXITCODE -ne 0) { throw 'Candidate syntax check failed' }
    & $NodePath --check $stagedBootstrap
    if ($LASTEXITCODE -ne 0) { throw 'Bootstrap syntax check failed' }
    $version = (@(& $NodePath $candidate --version) -join '').Trim()
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Candidate version check failed' }
    $bootstrapVersion = (@(& $NodePath $stagedBootstrap --version) -join '').Trim()
    if ($LASTEXITCODE -ne 0 -or $bootstrapVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Bootstrap version check failed' }
    if ($BootstrapSha256 -ine $ExpectedSha256) {
        $lowerCore = [version]($bootstrapVersion.Split('-')[0]) -lt [version]($version.Split('-')[0])
        $preToStable = $bootstrapVersion.Split('-')[0] -eq $version -and $bootstrapVersion.Contains('-') -and -not $version.Contains('-')
        if (-not $lowerCore -and -not $preToStable) { throw 'Different bootstrap bytes require a version preceding the stable candidate' }
    } elseif ($RequireOtaProof) { throw 'OTA proof requires a distinct older bootstrap artifact' }
    $report.phase='staged'; $report.version=$version; $report.bootstrapVersion=$bootstrapVersion
    $report.bundleSha256=$ExpectedSha256.ToLowerInvariant(); $report.bootstrapSha256=$BootstrapSha256.ToLowerInvariant()
    $report.harnessSha256=$HarnessSha256.ToLowerInvariant(); $report.configSha256=$configHash
    $report.stage=$stage; $report.node=$NodePath
    if ($Mode -eq 'Stage') {
        $report.passed=$true
        Save-Json $ReceiptPath $report
        $report | ConvertTo-Json -Depth 10 -Compress
        exit 0
    }
    if ([string]::IsNullOrWhiteSpace($AcceptanceReceipt) -or -not (Test-Path -LiteralPath $AcceptanceReceipt -PathType Leaf)) { throw 'Install requires the successful Windows loopback acceptance receipt' }
    $acceptance = ([IO.File]::ReadAllText($AcceptanceReceipt) | ConvertFrom-Json)
    if ($acceptance.passed -ne $true -or $acceptance.platform -ne 'win32' -or $acceptance.computerName -ine $ExpectedComputerName -or $acceptance.verifiedIdentity -ine $identity.Name -or $acceptance.harnessSha256 -ine $HarnessSha256 -or $acceptance.bundleSha256 -ine $ExpectedSha256 -or $acceptance.deviceVersion -ne $version -or @($acceptance.cases).Count -ne 10 -or @($acceptance.cases | Where-Object { $_.passed -ne $true }).Count -ne 0) { throw 'Acceptance receipt does not validate this computer and exact candidate' }
    if (Test-Path -LiteralPath $journalPath) {
        $unfinished = ([IO.File]::ReadAllText($journalPath) | ConvertFrom-Json)
        if ($unfinished.phase -in @('prepared','registered','switching','starting','rollback-pending')) {
            Restore-Previous $unfinished
            $unfinished.phase='rolled-back'
            Save-Json $journalPath $unfinished
        }
    }
    $oldTask = Existing-Task
    if ($null -ne $oldTask -and -not (Managed-Task $oldTask)) { throw 'The requested task name belongs to an unmanaged task; no task definition was replaced' }
    if ($null -ne $oldTask -and ([string]$oldTask.Principal.LogonType) -notin @('Interactive','InteractiveToken')) { throw 'Existing task requires a different logon authorization; automatic replacement was stopped' }
    $processes = @(Owned-RelayProcesses)
    $legacy = @($processes | Where-Object { $_.Legacy })
    $managed = @($processes | Where-Object { $_.Managed })
    if ($managed.Count -gt 0) {
        if ($null -eq $oldTask -or -not (Managed-Task $oldTask)) { throw 'Managed relay is active without the expected task; no process was stopped' }
        & $NodePath $bootstrapEntry update-check --config $ConfigPath | Out-Null
        $status = Read-Status
        if ($null -ne $status -and $status.phase -eq 'running' -and $status.sha256 -ieq $ExpectedSha256 -and $status.supervisorVersion -eq $version) {
            if ($RequireOtaProof -and $status.previousVersion -ne $bootstrapVersion) { throw 'The active relay lacks the requested bootstrap-to-stable evidence' }
            $report.phase='already-managed'; $report.passed=$true; $report.runtimeVersion=$status.version; $report.supervisorVersion=$status.supervisorVersion
            $report.runtimeSha256=$status.sha256; $report.otaProven=($BootstrapSha256 -ine $ExpectedSha256 -and $status.previousVersion -eq $bootstrapVersion)
            Save-Json $ReceiptPath $report
            $report | ConvertTo-Json -Depth 10 -Compress
            exit 0
        }
        throw 'Existing managed relay retains ownership; an update check was requested and the installer will retry later'
    }
    if ($legacy.Count -gt 1) { throw 'Multiple matching legacy relays require explicit reconciliation; none was stopped' }
    Copy-Verified $stagedBootstrap $bootstrapEntry $BootstrapSha256
    $backupDir = Join-Path $InstallRoot ('backups\' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
    [IO.Directory]::CreateDirectory($backupDir) | Out-Null
    $taskBackup = Join-Path $backupDir 'previous-task.xml'
    $taskBackupHash = ''
    if ($null -ne $oldTask) {
        [IO.File]::WriteAllText($taskBackup,(Export-ScheduledTask -TaskPath '\' -TaskName $TaskName),(New-Object Text.UTF8Encoding($false)))
        $taskBackupHash=Hash $taskBackup
    }
    $legacySource = $LegacyEntryPoint
    $legacyDigest = ''
    $legacyBackup = Join-Path $backupDir 'previous-cli.cjs'
    if ($legacy.Count -eq 1) {
        $legacySource = [string]$legacy[0].Entry
        $legacyDigest = Hash $legacySource
        Copy-Verified $legacySource $legacyBackup $legacyDigest
        # The observed 0.1.6 package bundles its JS but externalizes ws. Preserve
        # that runtime dependency beside the saved entry before stopping it.
        $entryDir = Split-Path -Parent $legacySource
        $packageDir = Split-Path -Parent $entryDir
        $wsCandidates = @(
            (Join-Path $entryDir 'node_modules\ws')
            (Join-Path $packageDir 'node_modules\ws')
            ([IO.Path]::GetFullPath((Join-Path $packageDir '..\..\ws')))
        )
        foreach ($wsSource in $wsCandidates) {
            if (Test-Path -LiteralPath $wsSource -PathType Container) {
                $dependencyRoot = Join-Path $backupDir 'node_modules'
                [IO.Directory]::CreateDirectory($dependencyRoot) | Out-Null
                Copy-Item -LiteralPath $wsSource -Destination (Join-Path $dependencyRoot 'ws') -Recurse
                break
            }
        }
        $oldVersion = @(& $NodePath $legacyBackup --version)
        if ($LASTEXITCODE -ne 0) { throw 'Preserved legacy runtime cannot start; the existing relay was not stopped' }
    }
    $legacyArgs = @('connect','--root',$RelayRoot,'--config',$ConfigPath,'--name',$deviceName,'--packs',$Packs)
    if ($AllowKernel) { $legacyArgs += '--allow-kernel' }
    $journal = [ordered]@{
        schemaVersion=1; phase='prepared'; computerName=$env:COMPUTERNAME; identity=$identity.Name
        configSha256=$configHash; bundleSha256=$ExpectedSha256.ToLowerInvariant(); bootstrapSha256=$BootstrapSha256.ToLowerInvariant()
        taskWasPresent=($null -ne $oldTask); taskWasRunning=($null -ne $oldTask -and [string]$oldTask.State -eq 'Running')
        taskBackup=$taskBackup; taskBackupSha256=$taskBackupHash
        legacyWasRunning=($legacy.Count -eq 1); legacyEntryPoint=$legacySource; legacyRestoreEntryPoint=$legacyBackup
        legacySha256=$legacyDigest
        legacyArgs=$legacyArgs; startedAt=[DateTime]::UtcNow.ToString('o')
    }
    Save-Json $journalPath $journal
    $transactionStarted=$true
    $arguments = @('connect','--root',$RelayRoot,'--config',$ConfigPath,'--name',$deviceName,'--packs',$Packs,'--update-manifest',$ManifestUrl,'--update-interval',[string]$UpdateIntervalSeconds)
    if ($AllowKernel) { $arguments += '--allow-kernel' }
    $startCode = Node-Invocation $bootstrapEntry $arguments (Join-Path $InstallRoot 'relay.log')
    [IO.File]::WriteAllText((Join-Path $InstallRoot 'start-relay.ps1'),$startCode,(New-Object Text.UTF8Encoding($false)))
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($startCode))
    $action = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $encoded) -WorkingDirectory $RelayRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $settings.Enabled = $false
    # Register disabled before stopping the old process, so missing task permissions leave
    # the existing relay online. No elevation, password prompt or consent dialog.
    Register-ScheduledTask -TaskPath '\' -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'My Devices relay managed by install-windows.ps1; stable Node and verified launcher' -Force | Out-Null
    $taskRegistered=$true
    $journal.phase='registered'; Save-Json $journalPath $journal
    if ((Hash $ConfigPath) -ne $configHash) { throw 'Configuration changed before the switch; stopped without touching its contents' }
    if ($legacy.Count -eq 1) {
        $stillOwned = @(Owned-RelayProcesses | Where-Object { $_.Legacy -and $_.Id -eq $legacy[0].Id })
        if ($stillOwned.Count -ne 1) { throw 'Legacy process identity changed before the switch; no process was terminated' }
        if ((Hash $journal.legacyEntryPoint) -ne $journal.legacySha256) { throw 'Legacy entry changed before the switch' }
        $journal.phase='switching'; Save-Json $journalPath $journal
        Stop-Process -Id $legacy[0].Id -Force -ErrorAction Stop
        $legacyStopped=$true
        $deadline=[DateTime]::UtcNow.AddSeconds(10)
        while (@(Owned-RelayProcesses | Where-Object { $_.Legacy }).Count -gt 0) {
            if ([DateTime]::UtcNow -gt $deadline) { throw 'The targeted legacy relay did not stop' }
            Start-Sleep -Milliseconds 200
        }
    }
    $journal.phase='starting'; Save-Json $journalPath $journal
    Enable-ScheduledTask -TaskPath '\' -TaskName $TaskName | Out-Null
    Start-ScheduledTask -TaskPath '\' -TaskName $TaskName
    $deadline=[DateTime]::UtcNow.AddSeconds($HealthTimeoutSeconds)
    $healthy=$false; $status=$null
    do {
        Start-Sleep -Milliseconds 500
        $status=Read-Status
        if ($null -ne $status -and $status.phase -eq 'running' -and $status.sha256 -ieq $ExpectedSha256 -and $status.version -eq $version -and $status.supervisorVersion -eq $version) {
            if (-not $RequireOtaProof -or $status.previousVersion -eq $bootstrapVersion) { $healthy=$true; break }
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $healthy) { throw 'New launcher did not prove authenticated stable worker and supervisor activation before the deadline' }
    if ((Hash $ConfigPath) -ne $configHash) { throw 'Configuration changed during activation; installer did not overwrite it' }
    $journal.phase='active'; $journal.completedAt=[DateTime]::UtcNow.ToString('o'); Save-Json $journalPath $journal
    $report.phase='active'; $report.passed=$true; $report.runtimeVersion=$status.version; $report.supervisorVersion=$status.supervisorVersion
    $report.runtimeSha256=$status.sha256; $report.otaProven=($BootstrapSha256 -ine $ExpectedSha256 -and $status.previousVersion -eq $bootstrapVersion)
    $report.taskName=$TaskName; $report.logonPersistence='current-user interactive logon'; $report.journal=$journalPath
    Save-Json $ReceiptPath $report
    $report | ConvertTo-Json -Depth 10 -Compress
    exit 0
} catch {
    $report.error=$_.Exception.Message
    $report.permissionDenied=($_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::PermissionDenied -or $_.Exception.HResult -eq -2147024891)
    $report.phase='failed'
    if ($transactionStarted -and $null -ne $journal) {
        try {
            $journal.phase='rollback-pending'; Save-Json $journalPath $journal
            Restore-Previous $journal
            $journal.phase='rolled-back'; Save-Json $journalPath $journal
            $report.rollback='previous entry and task restored'
        } catch {
            $report.rollback='incomplete; preserved journal requires the next bounded retry'
            $report.rollbackError=$_.Exception.Message
        }
    }
    $report.completedAt=[DateTime]::UtcNow.ToString('o')
    Save-Json $ReceiptPath $report
    $report | ConvertTo-Json -Depth 10 -Compress
    exit 1
} finally {
    if ($ownsMutex -and $null -ne $mutex) { $mutex.ReleaseMutex() }
    if ($null -ne $mutex) { $mutex.Dispose() }
}
