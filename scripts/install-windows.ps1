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
    [switch]$AllowComputer,
    [switch]$AddComputer,
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
$runtimeCommitted = $false
$bootstrapEntry = Join-Path $InstallRoot 'bootstrap.cjs'
$journalPath = Join-Path $InstallRoot 'install-journal.json'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$windowsScriptHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
$report = [ordered]@{
    schemaVersion=1; mode=$Mode; passed=$false; phase='validating'
    computerName=[Environment]::MachineName; identity=$identity.Name; administrator=$administrator
    startedAt=[DateTime]::UtcNow.ToString('o')
}
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Canonical([string]$Path) { return [IO.Path]::GetFullPath($Path).TrimEnd('\','/').ToLowerInvariant() }
function Ps-Quote([string]$Value) { return "'" + $Value.Replace("'","''") + "'" }

function Windows-Quote([string]$Value) {
    return '"' + [regex]::Replace([regex]::Replace($Value,'(\\*)"','$1$1\"'),'(\\+)$','$1$1') + '"'
}
function Vbs-Quote([string]$Value) { return '"' + $Value.Replace('"','""') + '"' }
function Hidden-Launcher([string]$Program,[string[]]$Arguments,[string]$WorkingDirectory) {
    foreach ($value in (@($Program,$WorkingDirectory) + @($Arguments))) {
        if ($value -match '[%\r\n\x00]') { throw 'Hidden launcher refuses environment expansion and control characters in its command' }
    }
    $command = @((@($Program) + @($Arguments)) | ForEach-Object { Windows-Quote $_ }) -join ' '
    return @(
        'Option Explicit'
        'Dim shell, exitCode'
        'Set shell = CreateObject("WScript.Shell")'
        ('shell.CurrentDirectory = ' + (Vbs-Quote $WorkingDirectory))
        ('exitCode = shell.Run(' + (Vbs-Quote $command) + ', 0, True)')
        'WScript.Quit exitCode'
    ) -join [Environment]::NewLine
}
function Assert-HiddenLauncherAvailable {
    if (-not (Test-Path -LiteralPath $windowsScriptHost -PathType Leaf)) { throw 'Windows Script Host is unavailable; the existing relay was not stopped' }
    foreach ($key in @('HKCU:\Software\Microsoft\Windows Script Host\Settings','HKLM:\Software\Microsoft\Windows Script Host\Settings')) {
        $policy=Get-ItemProperty -LiteralPath $key -Name Enabled -ErrorAction SilentlyContinue
        if ($null -ne $policy -and $policy.Enabled -eq 0) { throw 'Windows Script Host is disabled; the existing relay was not stopped' }
    }
    $probePath=Join-Path $InstallRoot ('hidden-launcher-probe-'+[Guid]::NewGuid().ToString('N')+'.vbs')
    [IO.File]::WriteAllText($probePath,'WScript.Quit 0',[Text.Encoding]::Unicode)
    $probe=New-Object Diagnostics.Process
    try {
        $probe.StartInfo.FileName=$windowsScriptHost
        $probe.StartInfo.Arguments='//B //NoLogo '+(Windows-Quote $probePath)
        $probe.StartInfo.UseShellExecute=$false
        $probe.StartInfo.CreateNoWindow=$true
        $probe.StartInfo.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
        [void]$probe.Start()
        if (-not $probe.WaitForExit(5000)) { $probe.Kill(); throw 'Windows Script Host probe timed out; the existing relay was not stopped' }
        if ($probe.ExitCode -ne 0) { throw 'Windows Script Host or VBScript is disabled/unavailable; the existing relay was not stopped' }
    } finally { $probe.Dispose() }
}

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
# Parse the argv emitted by Node/CreateProcess, including quoted paths and escaped
# quotes. A path substring is not sufficient evidence that a process is ours.
function Split-WindowsCommandLine([string]$CommandLine) {
    $result = New-Object 'Collections.Generic.List[string]'
    $index = 0
    while ($index -lt $CommandLine.Length) {
        while ($index -lt $CommandLine.Length -and [char]::IsWhiteSpace($CommandLine[$index])) { $index++ }
        if ($index -ge $CommandLine.Length) { break }
        $word = New-Object Text.StringBuilder
        $quoted = $false
        while ($index -lt $CommandLine.Length) {
            $char = $CommandLine[$index]
            if (-not $quoted -and [char]::IsWhiteSpace($char)) { break }
            if ($char -eq '\') {
                $slashes = 0
                while ($index -lt $CommandLine.Length -and $CommandLine[$index] -eq '\') { $slashes++; $index++ }
                if ($index -lt $CommandLine.Length -and $CommandLine[$index] -eq '"') {
                    [void]$word.Append(('\' * [int][Math]::Floor($slashes / 2)))
                    if (($slashes % 2) -eq 1) { [void]$word.Append('"') } else { $quoted = -not $quoted }
                    $index++
                } else { [void]$word.Append(('\' * $slashes)) }
                continue
            }
            if ($char -eq '"') { $quoted = -not $quoted; $index++; continue }
            [void]$word.Append($char)
            $index++
        }
        if ($quoted) { throw 'Unterminated process command-line quote; no process was stopped' }
        $result.Add($word.ToString())
    }
    return $result.ToArray()
}
function Relay-Options([string[]]$Arguments) {
    if ($null -eq $Arguments) { $Arguments=@() }
    $values = @{}
    $valueFlags = @('root','config','name','packs','url','code','update-manifest','update-interval')
    $booleanFlags = @('allow-shell','no-shell','allow-kernel','allow-computer','no-auto-update','verbose')
    $command = 'connect'
    $positional = $false
    for ($i = 0; $i -lt $Arguments.Count; $i++) {
        $item = $Arguments[$i]
        if (-not $item.StartsWith('--')) {
            if ($positional) { throw 'Unexpected positional relay argument; no process was stopped' }
            $command=$item; $positional=$true; continue
        }
        $option=$item.Substring(2)
        $equals=$option.IndexOf('=')
        $name=if ($equals -ge 0) { $option.Substring(0,$equals) } else { $option }
        if ($values.ContainsKey($name)) { throw 'Repeated relay option cannot be safely reconstructed' }
        if ($name -in $valueFlags) {
            if ($equals -ge 0) { $value=$option.Substring($equals+1) }
            else {
                $i++
                if ($i -ge $Arguments.Count) { throw 'Relay process is missing an option value' }
                $value=$Arguments[$i]
            }
            if ([string]::IsNullOrWhiteSpace($value)) { throw 'Relay process has an empty option value' }
            $values[$name]=$value
        } elseif ($name -in $booleanFlags -and $equals -lt 0) { $values[$name]=$true }
        else { throw 'Unknown relay option cannot be safely reconstructed' }
    }
    return [pscustomobject]@{ Command=$command; Values=$values }
}
function Owned-RelayProcesses {
    $found = @()
    $updatesRoot = Canonical (Join-Path (Split-Path -Parent $ConfigPath) 'updates')
    $releasePattern = '^' + [regex]::Escape($updatesRoot) + '[\\/][a-f0-9]{16}[\\/]releases[\\/]([a-f0-9]{64})[\\/]cli\.cjs$'
    $recoveryPattern = '^' + [regex]::Escape((Canonical $InstallRoot)) + '[\\/]backups[\\/][^\\/]+[\\/]previous-cli\.cjs$'
    foreach ($item in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")) {
        $command = [string]$item.CommandLine
        if ([string]::IsNullOrWhiteSpace($command)) { continue }
        # npm/npx wrappers are not relay owners. Parse the actual entry argv so
        # a custom InstallRoot and normalized .bin/../ paths are recognized.
        if ($command -notmatch '(?i)\.cjs') { continue }
        $argv = @(Split-WindowsCommandLine $command)
        if ($argv.Count -lt 2) { continue }
        if (-not [IO.Path]::IsPathRooted($argv[1]) -or $argv[1] -notmatch '(?i)\.cjs$') {
            foreach ($argument in $argv) {
                if ([IO.Path]::IsPathRooted($argument) -and $argument -match '(?i)\.cjs$') {
                    $possible=Canonical $argument
                    if ($possible -eq (Canonical $LegacyEntryPoint) -or $possible -eq (Canonical $bootstrapEntry) -or $possible -match $releasePattern) { throw 'Relay uses unsupported Node startup options; no process was stopped' }
                }
            }
            continue
        }
        $entry = [IO.Path]::GetFullPath($argv[1])
        $canonicalEntry = Canonical $entry
        $legacy = $canonicalEntry -eq (Canonical $LegacyEntryPoint) -or $canonicalEntry -match $recoveryPattern
        $bootstrap = $canonicalEntry -eq (Canonical $bootstrapEntry)
        $release = [regex]::Match($canonicalEntry,$releasePattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)
        $managed = $bootstrap -or $release.Success
        $packageKnown = $canonicalEntry -match '[\\/]@cyjin[\\/]mcp-relay[\\/]dist[\\/]cli\.cjs$'
        if (-not $legacy -and -not $managed -and -not $packageKnown) { continue }
        $arguments = @()
        if ($argv.Count -gt 2) { $arguments = @($argv[2..($argv.Count-1)]) }
        # Version/status commands are probes, not live relay connections.
        if (@($arguments | Where-Object { $_ -in @('--version','-v','--help','-h') }).Count -gt 0) { continue }
        $options = Relay-Options $arguments
        if ($options.Command -ne 'connect') { continue }
        $values=$options.Values
        $givenConfig=$values['config']
        if ($givenConfig) {
            if (-not [IO.Path]::IsPathRooted($givenConfig)) { throw 'Relative relay configuration cannot be safely reconciled' }
            if ((Canonical $givenConfig) -ne (Canonical $ConfigPath)) { continue }
        } elseif ((Canonical $ConfigPath) -ne (Canonical (Join-Path $env:USERPROFILE '.mcp-relay\device.json'))) { continue }
        $givenRoot=$values['root']
        if ($givenRoot) {
            if (-not [IO.Path]::IsPathRooted($givenRoot)) { throw 'Relative relay root cannot be safely reconciled' }
            if ((Canonical $givenRoot) -ne (Canonical $RelayRoot)) { continue }
        }
        if (-not $legacy -and -not $managed) { throw 'A relay uses an unexpected package entry; provide its verified LegacyEntryPoint instead of stopping it by name' }
        $owner = Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid
        if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $identity.User.Value) { throw 'A matching relay process is not verifiably owned by the current Windows identity' }
        $entryHash=Hash $entry
        if ($release.Success -and $entryHash -ne $release.Groups[1].Value) { throw 'A managed release failed integrity verification; no process was stopped' }
        $found += [pscustomobject]@{
            Id=[int]$item.ProcessId; ParentId=[int]$item.ParentProcessId; CreatedAt=$item.CreationDate.ToUniversalTime().ToString('o')
            Legacy=$legacy; Managed=$managed; Bootstrap=$bootstrap; Entry=$entry; EntrySha256=$entryHash
            Values=$values
        }
    }
    return $found
}
function Select-RelayLauncherTree([object[]]$Processes) {
    if ($null -eq $Processes -or $Processes.Count -eq 0) { return $null }
    $byId=@{}
    foreach ($process in $Processes) {
        if ($byId.ContainsKey($process.Id)) { throw 'Duplicate process identity; no process was stopped' }
        $byId[$process.Id]=$process
    }
    $roots=@($Processes | Where-Object { -not $byId.ContainsKey($_.ParentId) })
    if ($roots.Count -ne 1 -or $Processes.Count -gt 3) { throw 'Multiple matching relay launchers require explicit reconciliation; none was stopped' }
    $root=$roots[0]
    if (-not $root.Legacy -and -not $root.Bootstrap) { throw 'Relay worker has no verified launcher; no process was stopped' }
    $chain=@($root)
    $current=$root
    while ($true) {
        $children=@($Processes | Where-Object { $_.ParentId -eq $current.Id })
        if ($children.Count -eq 0) { break }
        if ($children.Count -ne 1 -or -not $children[0].Managed -or $children[0].Bootstrap) { throw 'Unexpected relay process topology; no process was stopped' }
        if ($chain.Id -contains $children[0].Id) { throw 'Cyclic process identity; no process was stopped' }
        $current=$children[0]
        $chain += $current
    }
    if ($chain.Count -ne $Processes.Count) { throw 'Unrelated relay processes cannot be migrated together' }
    # The supervisor explicitly expands defaults, including an npx launch with no
    # arguments. Its root/config identify the actual cwd of the original launcher.
    $effective=$chain[$chain.Count-1].Values
    if (-not $effective.ContainsKey('root')) { throw 'Implicit relay root cannot be verified without its supervisor; no process was stopped' }
    if ($chain.Count -gt 1 -and -not $effective.ContainsKey('config')) { throw 'Relay supervisor omitted its explicit configuration' }
    foreach ($member in $chain) {
        foreach ($key in @('root','config','name','url','update-manifest','update-interval')) {
            if ($member.Values.ContainsKey($key) -and $effective.ContainsKey($key) -and $member.Values[$key] -ine $effective[$key]) {
                if ($key -in @('root','config') -and (Canonical $member.Values[$key]) -eq (Canonical $effective[$key])) { continue }
                throw 'Relay launcher and worker settings disagree; no process was stopped'
            }
        }
        if ([bool]$member.Values['no-shell'] -ne [bool]$effective['no-shell'] -or [bool]$member.Values['allow-kernel'] -ne [bool]$effective['allow-kernel']) { throw 'Relay launcher and worker permissions disagree' }
        if ($member.Values.ContainsKey('packs') -and $effective.ContainsKey('packs')) {
            $missing=@(([string]$member.Values['packs']).Split(',') | Where-Object { $_ -notin ([string]$effective['packs']).Split(',') })
            $extra=@(([string]$effective['packs']).Split(',') | Where-Object { $_ -notin ([string]$member.Values['packs']).Split(',') -and $_ -ne 'computer' })
            if ($missing.Count -gt 0 -or $extra.Count -gt 0) { throw 'Relay launcher and worker tool packs disagree' }
        }
    }
    return [pscustomobject]@{ Root=$root; Processes=$chain; Values=$effective; AutoUpdate=(-not [bool]$root.Values['no-auto-update']) }
}
function Migration-Arguments($Tree) {
    $values=$Tree.Values
    $migrationArguments=@('connect','--root',$RelayRoot,'--config',$ConfigPath)
    foreach ($key in @('name','packs','url','update-manifest','update-interval')) {
        if ($values.ContainsKey($key)) {
            $value=[string]$values[$key]
            # Node parseArgs requires an equals form when a string value looks
            # like an option; preserve legitimate names such as --workstation.
            if ($value.StartsWith('--')) { $migrationArguments += ('--'+$key+'='+$value) }
            else { $migrationArguments += @(('--'+$key),$value) }
        }
    }
    foreach ($key in @('allow-shell','no-shell','allow-kernel','allow-computer','verbose')) {
        if ($values[$key]) { $migrationArguments += '--'+$key }
    }
    # A one-time pairing code never enters task arguments or recovery journals.
    if (-not $Tree.AutoUpdate) { $migrationArguments += '--no-auto-update' }
    return $migrationArguments
}
function Add-ComputerArguments([string[]]$Arguments) {
    $options=Relay-Options $Arguments
    if ($options.Command -ne 'connect') { throw 'Computer opt-in only applies to a connect invocation' }
    $packs=if ($options.Values.ContainsKey('packs')) { @(([string]$options.Values['packs']).Split(',')) } else { @('minimal','omp') }
    if ($packs -notcontains 'computer') { $packs += 'computer' }
    $value=$packs -join ','
    $result=@()
    for ($index=0; $index -lt $Arguments.Count; $index++) {
        $item=$Arguments[$index]
        if ($item -eq '--packs') { $result += @('--packs',$value); $index++ }
        elseif ($item.StartsWith('--packs=')) { $result += '--packs='+$value }
        elseif ($item.StartsWith('--') -and $item.IndexOf('=') -lt 0 -and $options.Values[$item.Substring(2)] -is [string]) { $result += @($item,$Arguments[++$index]) }
        else { $result += $item }
    }
    if (-not $options.Values.ContainsKey('packs')) { $result += @('--packs',$value) }
    if (-not $options.Values['allow-computer']) { $result += '--allow-computer' }
    return $result
}
function Managed-Arguments($Tree,[string[]]$PreviousArguments) {
    $managedArguments=@($PreviousArguments)
    if ($null -ne $Tree -and -not $Tree.AutoUpdate) {
        # Migration-Arguments appends the flag as its final token. A value with
        # the same spelling remains intact in its --name=value representation.
        $managedArguments=@($PreviousArguments[0..($PreviousArguments.Count-2)])
    }
    if ($null -eq $Tree -or -not $Tree.Values.ContainsKey('update-manifest')) { $managedArguments += @('--update-manifest',$ManifestUrl) }
    if ($null -eq $Tree -or -not $Tree.Values.ContainsKey('update-interval')) { $managedArguments += @('--update-interval',[string]$UpdateIntervalSeconds) }
    if ($AddComputer) { $managedArguments = @(Add-ComputerArguments $managedArguments) }
    return $managedArguments
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
function Same-TaskAction($Left,$Right) {
    $a=@($Left.Actions); $b=@($Right.Actions)
    return ($a.Count -eq 1 -and $b.Count -eq 1 -and (Canonical ([string]$a[0].Execute)) -eq (Canonical ([string]$b[0].Execute)) -and [string]$a[0].Arguments -ceq [string]$b[0].Arguments -and [string]$a[0].WorkingDirectory -ceq [string]$b[0].WorkingDirectory)
}
function Update-ComputerTaskAction($Task,$Tree) {
    $oldActions=@($Task.Actions)
    if ($oldActions.Count -ne 1 -or (Canonical ([string]$oldActions[0].Execute)) -notin @((Canonical $windowsScriptHost),(Canonical $windowsPowerShell),(Canonical $NodePath))) { throw 'Managed task uses an unrecognized action; computer startup options were not changed' }
    $targetArguments=@(Managed-Arguments $Tree @(Migration-Arguments $Tree))
    $startCode=Node-Invocation $bootstrapEntry $targetArguments (Join-Path $InstallRoot 'relay.log')
    $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($startCode))
    $hiddenCode=Hidden-Launcher $windowsPowerShell @('-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',$encoded) $RelayRoot
    if (-not (Same-TaskAction (Existing-Task) $Task)) { throw 'Managed task action changed before computer opt-in; no action was replaced' }
    if ((Canonical ([string]$oldActions[0].Execute)) -eq (Canonical $windowsScriptHost)) {
        $oldArguments=@(Split-WindowsCommandLine ([string]$oldActions[0].Arguments))
        if ($oldArguments.Count -eq 3 -and $oldArguments[0] -ieq '//B' -and $oldArguments[1] -ieq '//NoLogo' -and (Canonical $oldArguments[2]).StartsWith((Canonical $InstallRoot)+[IO.Path]::DirectorySeparatorChar) -and (Test-Path -LiteralPath $oldArguments[2] -PathType Leaf) -and [IO.File]::ReadAllText($oldArguments[2]) -ceq $hiddenCode) { return $false }
    }
    $backup=Join-Path $InstallRoot ('backups\computer-action-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($backup) | Out-Null
    $xml=Join-Path $backup 'previous-task.xml'
    [IO.File]::WriteAllText($xml,(Export-ScheduledTask -TaskPath '\' -TaskName $TaskName),(New-Object Text.UTF8Encoding($false)))
    $hidden=Join-Path $backup 'start-relay-hidden.vbs'
    [IO.File]::WriteAllText($hidden,$hiddenCode,[Text.Encoding]::Unicode)
    $action=New-ScheduledTaskAction -Execute $windowsScriptHost -Argument ('//B //NoLogo '+(Windows-Quote $hidden)) -WorkingDirectory $RelayRoot
    $expected=[pscustomobject]@{Actions=@($action)}
    $report.taskActionBackup=$xml; $report.taskActionBackupSha256=Hash $xml
    try {
        Set-ScheduledTask -TaskPath '\' -TaskName $TaskName -Action $action | Out-Null
        if (-not (Same-TaskAction (Existing-Task) $expected) -or [IO.File]::ReadAllText($hidden) -cne $hiddenCode) { throw 'Managed computer startup action did not read back exactly' }
    } catch {
        $failure=$_
        $current=Existing-Task
        if (Same-TaskAction $current $expected) {
            Set-ScheduledTask -TaskPath '\' -TaskName $TaskName -Action $oldActions | Out-Null
            if (-not (Same-TaskAction (Existing-Task) $Task)) { throw 'Computer startup action rollback is pending; preserved task XML must be reconciled' }
        } elseif (-not (Same-TaskAction $current $Task)) { throw 'Managed task action changed concurrently; preserved task XML must be reconciled' }
        throw $failure
    }
    $report.taskActionUpdated=$true
    return $true
}
function Invoke-ComputerControl([string]$Command,[bool]$DefaultEnabled=$false) {
    $arguments=@($candidate,$Command,'--config',$ConfigPath)
    if ($DefaultEnabled) { $arguments += '--allow-computer' }
    $raw=@(& $NodePath @arguments 2>$null)
    if ($LASTEXITCODE -ne 0) { throw ('Computer control command did not finish successfully: '+$Command) }
    try { $settings=($raw -join [Environment]::NewLine)|ConvertFrom-Json } catch { throw 'Computer control did not return a settings receipt' }
    if ($settings.schema -ne 1 -or $settings.enabled -isnot [bool] -or $settings.paused -isnot [bool]) { throw 'Computer control settings receipt is invalid' }
    return $settings
}
function Read-ComputerActivation([string[]]$RequiredPacks) {
    $tree=$null
    try { $tree=Select-RelayLauncherTree @(Owned-RelayProcesses) } catch { }
    if ($null -eq $tree -or -not $tree.Root.Bootstrap -or $tree.Processes.Count -ne 3) {
        # Without the live argv, a missing sidecar cannot be distinguished from
        # an existing --allow-computer default. Do not infer a disabled setting.
        return [ordered]@{
            requested=$true; enabled=$null; paused=$null; settingsVerified=$false
            effectivePacks=@(); workerPackVerified=$false; runtimeReady=$false; complete=$false
            registrationVerified=$false; registrationVerification='requires fresh server MCP discovery'
            reason='Live managed relay tree is not verified; computer settings were not changed'
        }
    }
    $defaultEnabled=[bool]$tree.Values['allow-computer']
    $settings=Invoke-ComputerControl 'computer-status' $defaultEnabled
    $argvPacks=if ($null -ne $tree -and $tree.Values.ContainsKey('packs')) { @(([string]$tree.Values['packs']).Split(',')) } else { @() }
    $packs=@($argvPacks)
    # cli.ts constructs a computer pack whenever it is explicit in argv, even
    # when a sidecar disables or pauses control. An implicit pack needs proof
    # that this authenticated worker loaded the enabled sidecar.
    if ($settings.enabled -and $packs -notcontains 'computer') { $packs += 'computer' }
    $state=Read-Status
    $worker=$null
    if ($null -ne $tree -and $tree.Root.Bootstrap -and $tree.Processes.Count -eq 3) { $worker=$tree.Processes[2] }
    $created=if ($null -ne $worker) { ([DateTimeOffset]([DateTime]$worker.CreatedAt)).ToUnixTimeMilliseconds() } else { 0 }
    $ready=($null -ne $worker -and $worker.EntrySha256 -ieq $ExpectedSha256 -and $null -ne $state -and $state.phase -eq 'running' -and $state.sha256 -ieq $ExpectedSha256 -and $state.version -eq $version -and $state.supervisorVersion -eq $version -and $state.updatedAt -ge $created)
    $settingsLoaded=($argvPacks -contains 'computer')
    $reloadVerified=$false
    if ($settings.PSObject.Properties.Name -contains 'revision' -and $null -ne $state -and $state.PSObject.Properties.Name -contains 'reload' -and $null -ne $state.reload) {
        $reloadVerified=($state.reload.status -eq 'completed' -and $state.reload.requestKey -ceq $settings.revision)
        $settingsLoaded=$settingsLoaded -or $reloadVerified
    }
    if (-not $settingsLoaded -and $ready -and $settings.PSObject.Properties.Name -contains 'updatedAt') {
        # A fresh start can load an already-enabled sidecar without requesting
        # another reload. Invalid optional timestamps cannot establish proof.
        try { $settingsLoaded=($created -ge ([DateTimeOffset]([DateTime]$settings.updatedAt)).ToUnixTimeMilliseconds()) } catch { }
    }
    $packVerified=($ready -and $settingsLoaded -and @($RequiredPacks | Where-Object { $_ -notin $packs }).Count -eq 0 -and $packs -contains 'computer')
    return [ordered]@{
        requested=$true; enabled=$settings.enabled; paused=$settings.paused; settingsVerified=$true; effectivePacks=$packs
        workerPackVerified=$packVerified; runtimeReady=$ready; complete=($settings.enabled -and $packVerified)
        reloadRevisionVerified=$reloadVerified; settingsLoaded=$settingsLoaded
        workerPid=$(if ($null -ne $worker) { $worker.Id } else { $null })
        workerCreatedAt=$(if ($null -ne $worker) { $worker.CreatedAt } else { $null })
        workerSha256=$(if ($null -ne $worker) { $worker.EntrySha256 } else { $null })
        settingsRevision=$(if ($settings.PSObject.Properties.Name -contains 'revision') { $settings.revision } else { $null })
        registrationVerified=$false; registrationVerification='requires fresh server MCP discovery'
    }
}
function Ensure-ComputerActivation([string[]]$RequiredPacks) {
    $activation=Read-ComputerActivation $RequiredPacks
    $activation.enableInvoked=$false
    if (-not $activation.settingsVerified) { return $activation }
    if (-not $activation.enabled -and -not $activation.runtimeReady) {
        $activation.reason='Target worker readiness is pending; computer settings were not changed'
        return $activation
    }
    if (-not $activation.enabled) {
        # Explicit AddComputer grants opt-in. Never resume local pause or kill
        # a busy worker; computer-enable asks the supervisor for safe drain.
        $activation.enableInvoked=$true
        try { $enabled=Invoke-ComputerControl 'computer-enable' }
        catch { $activation.complete=$false; $activation.reason=$_.Exception.Message; return $activation }
        $activation.enabled=$enabled.enabled; $activation.paused=$enabled.paused
    }
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $waitMilliseconds=[Math]::Min(20000,$HealthTimeoutSeconds*1000)
    do {
        $invoked=$activation.enableInvoked
        $activation=Read-ComputerActivation $RequiredPacks
        $activation.enableInvoked=$invoked
        if (-not $activation.settingsVerified) { return $activation }
        if ($activation.complete) { return $activation }
        if (-not $activation.enabled) { $activation.reason='Computer control was disabled during activation; it was not enabled again'; return $activation }
        if ($clock.ElapsedMilliseconds -ge $waitMilliseconds) { break }
        Start-Sleep -Milliseconds 250
    } while ($true)
    $activation.reason='Computer opt-in is saved, but a safely drained worker with the required packs is still pending'
    return $activation
}
function Complete-ComputerOptIn($Tree,$Task=$null) {
    $report.installationCommitted=$true
    if ($null -ne $Task) { Update-ComputerTaskAction $Task $Tree | Out-Null }
    $required=if ($null -ne $Tree -and $Tree.Values.ContainsKey('packs')) { @(([string]$Tree.Values['packs']).Split(',')) } else { @($Packs.Split(',')) }
    if ($required -notcontains 'computer') { $required += 'computer' }
    $report.computer=Ensure-ComputerActivation $required
    if (-not $report.computer.complete) { throw ([string]$report.computer.reason) }
}
function Restore-Previous($Saved) {
    if ($Saved -is [Collections.IDictionary]) { $Saved = ($Saved | ConvertTo-Json -Depth 15 | ConvertFrom-Json) }
    if ($Saved.computerName -ine $ExpectedComputerName -or $Saved.identity -ine $identity.Name) { throw 'Recovery journal identity mismatch' }
    $currentTask = Existing-Task
    if ($null -ne $currentTask -and (Managed-Task $currentTask)) {
        Stop-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    $previousStillRunning = $false
    if ($Saved.PSObject.Properties.Name -contains 'legacyProcessId' -and $Saved.legacyWasRunning) {
        $previousStillRunning = @(Owned-RelayProcesses | Where-Object { $_.Id -eq $Saved.legacyProcessId -and $_.CreatedAt -eq $Saved.legacyProcessCreatedAt -and (Canonical $_.Entry) -eq (Canonical $Saved.legacyEntryPoint) -and $_.EntrySha256 -eq $Saved.legacySha256 }).Count -eq 1
    }
    if (-not $previousStillRunning) { Wait-NoManaged 20 }
    if ((Hash $ConfigPath) -ne $Saved.configSha256) { throw 'Device configuration changed during deployment; recovery stopped without overwriting credentials' }
    if ($Saved.taskWasPresent) {
        if (-not (Test-Path -LiteralPath $Saved.taskBackup -PathType Leaf) -or (Hash $Saved.taskBackup) -ne $Saved.taskBackupSha256) { throw 'Previous task backup failed integrity verification' }
        Register-ScheduledTask -TaskPath '\' -TaskName $TaskName -Xml ([IO.File]::ReadAllText($Saved.taskBackup)) -Force | Out-Null
        if ($Saved.taskWasRunning) { Start-ScheduledTask -TaskPath '\' -TaskName $TaskName }
    } elseif ($null -ne $currentTask -and (Managed-Task $currentTask)) {
        Unregister-ScheduledTask -TaskPath '\' -TaskName $TaskName -Confirm:$false
    }
    if ($Saved.legacyWasRunning -and -not $Saved.taskWasRunning -and -not $previousStillRunning -and @(Owned-RelayProcesses | Where-Object { $_.Legacy }).Count -eq 0) {
        if ((Hash $Saved.legacyRestoreEntryPoint) -ne $Saved.legacySha256) { throw 'Previous relay entry failed integrity verification' }
        $restoreCode = Node-Invocation $Saved.legacyRestoreEntryPoint @($Saved.legacyArgs) (Join-Path $InstallRoot 'rollback.log')
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($restoreCode))
        $rollbackLauncher=Join-Path $InstallRoot ('rollback-hidden-'+[Guid]::NewGuid().ToString('N')+'.vbs')
        $hiddenCode=Hidden-Launcher $windowsPowerShell @('-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',$encoded) $RelayRoot
        [IO.File]::WriteAllText($rollbackLauncher,$hiddenCode,[Text.Encoding]::Unicode)
        Start-Process -FilePath $windowsScriptHost -ArgumentList @('//B','//NoLogo',(Windows-Quote $rollbackLauncher)) -WorkingDirectory $RelayRoot -WindowStyle Hidden | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while (@(Owned-RelayProcesses | Where-Object { $_.Legacy }).Count -eq 0) {
            if ([DateTime]::UtcNow -gt $deadline) { throw 'Previous relay restart was not observed; recovery evidence was retained' }
            Start-Sleep -Milliseconds 250
        }
    }
}
try {
    if ([Environment]::MachineName -ine $ExpectedComputerName -or $identity.Name -ine $ExpectedIdentity) { throw 'Unexpected Windows computer or account identity; deployment stopped' }
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
    if ($Packs -notmatch '^(minimal|omp|kernel|computer)(,(minimal|omp|kernel|computer))*$' -or ($Packs -match 'kernel' -and -not $AllowKernel)) { throw 'Requested packs or kernel authorization are invalid' }
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
    Assert-HiddenLauncherAvailable
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
    $migration = Select-RelayLauncherTree $processes
    $legacy = @()
    if ($null -ne $migration) { $legacy = @($migration.Root) }
    # Release workers below an npx launcher do not imply a Scheduled Task exists.
    # Only a verified managed bootstrap rooted in that task is already installed.
    if ($null -ne $migration -and $migration.Root.Bootstrap -and $null -ne $oldTask -and [string]$oldTask.State -eq 'Running') {
        $status=if ($AddComputer) { Read-Status } else { $null }
        if ($null -eq $status -or $status.phase -ne 'running' -or $status.sha256 -ine $ExpectedSha256 -or $status.supervisorVersion -ne $version) {
            & $NodePath $bootstrapEntry update-check --config $ConfigPath | Out-Null
            $status=Read-Status
        }
        if ($null -ne $status -and $status.phase -eq 'running' -and $status.sha256 -ieq $ExpectedSha256 -and $status.supervisorVersion -eq $version) {
            if ($RequireOtaProof -and $status.previousVersion -ne $bootstrapVersion) { throw 'The active relay lacks the requested bootstrap-to-stable evidence' }
            # Replace only the next-start action of older console-host tasks.
            # Their current relay and terminal processes are left running.
            $oldActions=@($oldTask.Actions)
            if ($oldActions.Count -ne 1) { throw 'Managed task has an unexpected action count; no action was changed' }
            if ($AddComputer) {
                $report.installedPhase='already-managed'
                $report.runtimeVersion=$status.version; $report.supervisorVersion=$status.supervisorVersion
                $report.runtimeSha256=$status.sha256; $report.otaProven=($BootstrapSha256 -ine $ExpectedSha256 -and $status.previousVersion -eq $bootstrapVersion)
                Complete-ComputerOptIn $migration $oldTask
            } elseif ((Canonical ([string]$oldActions[0].Execute)) -ne (Canonical $windowsScriptHost)) {
                if ((Canonical ([string]$oldActions[0].Execute)) -notin @((Canonical $windowsPowerShell),(Canonical $NodePath))) { throw 'Managed task uses an unrecognized executable; no action was changed' }
                $actionBackupDir=Join-Path $InstallRoot ('backups\hidden-action-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N'))
                [IO.Directory]::CreateDirectory($actionBackupDir) | Out-Null
                $actionBackup=Join-Path $actionBackupDir 'previous-task.xml'
                [IO.File]::WriteAllText($actionBackup,(Export-ScheduledTask -TaskPath '\' -TaskName $TaskName),(New-Object Text.UTF8Encoding($false)))
                $actionWorkingDirectory=[string]$oldActions[0].WorkingDirectory
                if ([string]::IsNullOrWhiteSpace($actionWorkingDirectory)) { $actionWorkingDirectory=$RelayRoot }
                $oldArguments=@(Split-WindowsCommandLine ([string]$oldActions[0].Arguments))
                $hiddenExisting=Join-Path $actionBackupDir 'start-relay-hidden.vbs'
                [IO.File]::WriteAllText($hiddenExisting,(Hidden-Launcher ([string]$oldActions[0].Execute) $oldArguments $actionWorkingDirectory),[Text.Encoding]::Unicode)
                $hiddenAction=New-ScheduledTaskAction -Execute $windowsScriptHost -Argument ('//B //NoLogo '+(Windows-Quote $hiddenExisting)) -WorkingDirectory $actionWorkingDirectory
                Set-ScheduledTask -TaskPath '\' -TaskName $TaskName -Action $hiddenAction | Out-Null
                $report.taskActionUpdated=$true
                $report.taskActionBackup=$actionBackup
                $report.taskActionBackupSha256=Hash $actionBackup
            }
            $report.launcherMode='hidden-gui-host'
            $report.phase='already-managed'; $report.passed=$true; $report.runtimeVersion=$status.version; $report.supervisorVersion=$status.supervisorVersion
            $report.runtimeSha256=$status.sha256; $report.otaProven=($BootstrapSha256 -ine $ExpectedSha256 -and $status.previousVersion -eq $bootstrapVersion)
            Save-Json $ReceiptPath $report
            $report | ConvertTo-Json -Depth 10 -Compress
            exit 0
        }
        throw 'Existing managed relay retains ownership; an update check was requested and the installer will retry later'
    }
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
    if ($AllowComputer) { $legacyArgs += '--allow-computer' }
    if ($null -ne $migration) {
        $legacyArgs = @(Migration-Arguments $migration)
        if ($migration.Values.ContainsKey('url') -and ([string]$migration.Values['url']).TrimEnd('/') -ine $ExpectedRelayUrl.TrimEnd('/')) { throw 'Running relay belongs to another server; no process was stopped' }
        if ($migration.Values.ContainsKey('update-manifest') -and $migration.Values['update-manifest'] -ine $ManifestUrl) { throw 'Running relay uses a different update channel; pass that verified ManifestUrl to preserve it' }
        $report.migratedProcessCount=$migration.Processes.Count
        $report.migratedLauncherId=$migration.Root.Id
    }
    $journal = [ordered]@{
        schemaVersion=1; phase='prepared'; computerName=[Environment]::MachineName; identity=$identity.Name
        configSha256=$configHash; bundleSha256=$ExpectedSha256.ToLowerInvariant(); bootstrapSha256=$BootstrapSha256.ToLowerInvariant()
        taskWasPresent=($null -ne $oldTask); taskWasRunning=($null -ne $oldTask -and [string]$oldTask.State -eq 'Running')
        taskBackup=$taskBackup; taskBackupSha256=$taskBackupHash
        legacyWasRunning=($legacy.Count -eq 1); legacyEntryPoint=$legacySource; legacyRestoreEntryPoint=$legacyBackup
        legacySha256=$legacyDigest
        legacyProcessId=$(if ($legacy.Count -eq 1) { $legacy[0].Id } else { $null })
        legacyProcessCreatedAt=$(if ($legacy.Count -eq 1) { $legacy[0].CreatedAt } else { $null })
        legacyArgs=$legacyArgs; startedAt=[DateTime]::UtcNow.ToString('o')
    }
    Save-Json $journalPath $journal
    $transactionStarted=$true
    $arguments = @(Managed-Arguments $migration $legacyArgs)
    $startCode = Node-Invocation $bootstrapEntry $arguments (Join-Path $InstallRoot 'relay.log')
    [IO.File]::WriteAllText((Join-Path $InstallRoot 'start-relay.ps1'),$startCode,(New-Object Text.UTF8Encoding($false)))
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($startCode))
    # The task itself is a GUI host; a console application with WindowStyle Hidden
    # can still flash its console before applying that flag.
    $hiddenLauncher=Join-Path $backupDir 'start-relay-hidden.vbs'
    $hiddenCode=Hidden-Launcher $windowsPowerShell @('-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',$encoded) $RelayRoot
    [IO.File]::WriteAllText($hiddenLauncher,$hiddenCode,[Text.Encoding]::Unicode)
    $journal.hiddenLauncher=$hiddenLauncher
    $journal.hiddenLauncherSha256=Hash $hiddenLauncher
    Save-Json $journalPath $journal
    $action = New-ScheduledTaskAction -Execute $windowsScriptHost -Argument ('//B //NoLogo '+(Windows-Quote $hiddenLauncher)) -WorkingDirectory $RelayRoot
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
        $stillOwned = Select-RelayLauncherTree @(Owned-RelayProcesses)
        if ($null -eq $stillOwned -or $stillOwned.Root.Id -ne $legacy[0].Id -or $stillOwned.Root.CreatedAt -ne $legacy[0].CreatedAt -or (Canonical $stillOwned.Root.Entry) -ne (Canonical $journal.legacyEntryPoint)) { throw 'Legacy process identity changed before the switch; no process was terminated' }
        if ((Hash $journal.legacyEntryPoint) -ne $journal.legacySha256) { throw 'Legacy entry changed before the switch' }
        if ((@(Migration-Arguments $stillOwned) | ConvertTo-Json -Compress) -ne ($legacyArgs | ConvertTo-Json -Compress)) { throw 'Relay settings changed before the switch; no process was terminated' }
        $journal.phase='switching'; Save-Json $journalPath $journal
        # Stop only the verified launcher. Its supervisor and worker observe IPC
        # disconnect and shut down; never taskkill a broad Node/npm process tree.
        Stop-Process -Id $legacy[0].Id -Force -ErrorAction Stop
        $legacyStopped=$true
        $deadline=[DateTime]::UtcNow.AddSeconds(20)
        while (@(Owned-RelayProcesses).Count -gt 0) {
            if ([DateTime]::UtcNow -gt $deadline) { throw 'The verified relay tree did not finish shutting down; no remaining process was force-stopped' }
            Start-Sleep -Milliseconds 200
        }
    }
    $journal.phase='starting'; Save-Json $journalPath $journal
    Enable-ScheduledTask -TaskPath '\' -TaskName $TaskName | Out-Null
    $taskStartedAt=[DateTime]::UtcNow
    $taskStartedMs=([DateTimeOffset]$taskStartedAt).ToUnixTimeMilliseconds()
    Start-ScheduledTask -TaskPath '\' -TaskName $TaskName
    $deadline=[DateTime]::UtcNow.AddSeconds($HealthTimeoutSeconds)
    $healthy=$false; $status=$null
    do {
        Start-Sleep -Milliseconds 500
        $status=Read-Status
        if ($null -ne $status -and $status.phase -eq 'running' -and $status.sha256 -ieq $ExpectedSha256 -and $status.version -eq $version -and $status.supervisorVersion -eq $version -and $status.updatedAt -ge $taskStartedMs) {
            # A stale state file is not evidence that this Scheduled Task started.
            # Bind health to a new, verified bootstrap/supervisor/worker tree.
            $healthyTree=$null
            try { $healthyTree=Select-RelayLauncherTree @(Owned-RelayProcesses) } catch { continue }
            $runningTask=Existing-Task
            if ($null -ne $healthyTree -and $healthyTree.Root.Bootstrap -and $healthyTree.Processes.Count -eq 3 -and $healthyTree.Root.EntrySha256 -eq $BootstrapSha256.ToLowerInvariant() -and ([DateTime]$healthyTree.Root.CreatedAt).ToUniversalTime() -ge $taskStartedAt -and $null -ne $runningTask -and [string]$runningTask.State -eq 'Running') {
                if (-not $RequireOtaProof -or $status.previousVersion -eq $bootstrapVersion) { $healthy=$true; break }
            }
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $healthy) { throw 'New launcher did not prove authenticated stable worker and supervisor activation before the deadline' }
    if ((Hash $ConfigPath) -ne $configHash) { throw 'Configuration changed during activation; installer did not overwrite it' }
    $journal.phase='active'; $journal.completedAt=[DateTime]::UtcNow.ToString('o'); Save-Json $journalPath $journal
    if ($AddComputer) {
        $runtimeCommitted=$true; $report.installedPhase='active'
        $report.runtimeVersion=$status.version; $report.supervisorVersion=$status.supervisorVersion
        $report.runtimeSha256=$status.sha256; $report.otaProven=($BootstrapSha256 -ine $ExpectedSha256 -and $status.previousVersion -eq $bootstrapVersion)
        $report.journal=$journalPath
        Complete-ComputerOptIn $healthyTree
    }
    $report.phase='active'; $report.passed=$true; $report.runtimeVersion=$status.version; $report.supervisorVersion=$status.supervisorVersion
    $report.runtimeSha256=$status.sha256; $report.otaProven=($BootstrapSha256 -ine $ExpectedSha256 -and $status.previousVersion -eq $bootstrapVersion)
    $report.taskName=$TaskName; $report.logonPersistence='current-user interactive logon'; $report.journal=$journalPath
    $report.launcherPid=$healthyTree.Root.Id; $report.workerPid=$healthyTree.Processes[2].Id
    $report.taskStartedAt=$taskStartedAt.ToString('o'); $report.stateUpdatedAt=$status.updatedAt
    Save-Json $ReceiptPath $report
    $report | ConvertTo-Json -Depth 10 -Compress
    exit 0
} catch {
    $report.error=$_.Exception.Message
    $report.permissionDenied=($_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::PermissionDenied -or $_.Exception.HResult -eq -2147024891)
    $committed=($runtimeCommitted -or ($report.Contains('installationCommitted') -and $report.installationCommitted))
    $report.phase=if ($committed -and $AddComputer) { 'capability-pending' } else { 'failed' }
    if ($committed) { $report.installationCommitted=$true; $report.rollback='not attempted; the healthy managed installation remains active' }
    if (-not $committed -and $transactionStarted -and $null -ne $journal) {
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
