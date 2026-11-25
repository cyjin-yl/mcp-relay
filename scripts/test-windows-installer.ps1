[CmdletBinding()]
param([string]$InstallerPath = (Join-Path $PSScriptRoot 'install-windows.ps1'))
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Load only named functions. The installer body is never executed. Task/process
# operations are mocked; task-action tests use only their own temporary files.
$tokens=$null
$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($InstallerPath,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
$names=@('Windows-Quote','Vbs-Quote','Hidden-Launcher','Canonical','Split-WindowsCommandLine','Relay-Options','Owned-RelayProcesses','Select-RelayLauncherTree','Migration-Arguments','Managed-Arguments','Add-ComputerArguments','Hash','Ps-Quote','Node-Invocation','Update-ComputerTaskAction','Same-TaskAction','Read-ComputerActivation','Ensure-ComputerActivation','Complete-ComputerOptIn')
foreach ($name in $names) {
    $functionAst=$ast.Find({ param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name },$true)
    if ($null -eq $functionAst) { throw ('Missing installer function '+$name) }
    . ([scriptblock]::Create($functionAst.Extent.Text))
}
$RelayRoot='C:\Users\ezra'
$ConfigPath='C:\Users\ezra\.mcp-relay\device.json'
$AddComputer=$false
$results=New-Object 'Collections.Generic.List[object]'
function Assert-Equal($Actual,$Expected) {
    if (($Actual | ConvertTo-Json -Compress -Depth 8) -cne ($Expected | ConvertTo-Json -Compress -Depth 8)) { throw ('Expected '+($Expected|ConvertTo-Json -Compress)+'; got '+($Actual|ConvertTo-Json -Compress)) }
}
function Assert-Throws([scriptblock]$Run,[string]$Pattern) {
    try { & $Run } catch { if ($_.Exception.Message -notmatch $Pattern) { throw }; return }
    throw ('Expected refusal matching '+$Pattern)
}
function Case([string]$Name,[scriptblock]$Run) {
    try { & $Run; $results.Add([pscustomobject]@{name=$Name;passed=$true}) }
    catch { $results.Add([pscustomobject]@{name=$Name;passed=$false;error=$_.Exception.Message}) }
}
function Process-Record([int]$Id,[int]$ParentId,[hashtable]$Values,[bool]$Legacy=$false,[bool]$Bootstrap=$false) {
    return [pscustomobject]@{Id=$Id;ParentId=$ParentId;Values=$Values;Legacy=$Legacy;Bootstrap=$Bootstrap;Managed=(-not $Legacy)}
}
function Runtime-Values {
    return @{'root'=$RelayRoot;'config'=$ConfigPath;'name'='TB14P-EZRA';'packs'='minimal,omp';'no-auto-update'=$true;'update-interval'='300'}
}
function Normal-Tree {
    return @((Process-Record 67384 49812 @{} $true),(Process-Record 72040 67384 (Runtime-Values)),(Process-Record 69756 72040 (Runtime-Values)))
}
Case 'implicit npx launcher argv with dot segments and spaces' {
    $argv=@(Split-WindowsCommandLine '"node"   "C:\Users\ezra\AppData\Local\npm-cache\_npx\71175ae0e040d800\node_modules\.bin\\..\@cyjin\mcp-relay\dist\cli.cjs"')
    Assert-Equal $argv.Count 2
    Assert-Equal (Canonical $argv[1]) 'c:\users\ezra\appdata\local\npm-cache\_npx\71175ae0e040d800\node_modules\@cyjin\mcp-relay\dist\cli.cjs'
    Assert-Equal (Relay-Options @()).Command 'connect'
}
Case 'quoted Unicode and escaped quotes round trip' {
    $argv=@(Split-WindowsCommandLine 'node "C:\a b\cli.cjs" connect --name "a \"quoted\" 中文" --root "C:\workspace with spaces\\"')
    Assert-Equal $argv @('node','C:\a b\cli.cjs','connect','--name','a "quoted" 中文','--root','C:\workspace with spaces\')
}
Case 'unclosed process quotes are refused' { Assert-Throws { Split-WindowsCommandLine 'node "broken' } 'Unterminated' }
Case 'options parse reordered connect and equals values' {
    $options=Relay-Options @('--name=a b','--no-shell','connect','--root',$RelayRoot)
    Assert-Equal $options.Command 'connect'
    Assert-Equal $options.Values['name'] 'a b'
    Assert-Equal $options.Values['no-shell'] $true
}
Case 'duplicate and unknown options are refused' {
    Assert-Throws { Relay-Options @('--root','C:\a','--root','C:\b') } 'Repeated'
    Assert-Throws { Relay-Options @('--unreviewed','x') } 'Unknown'
}
Case 'normal three layer launcher is one relay instance' {
    $tree=Select-RelayLauncherTree (Normal-Tree)
    Assert-Equal $tree.Root.Id 67384
    Assert-Equal $tree.Processes.Count 3
    Assert-Equal $tree.AutoUpdate $true
    Assert-Equal (Migration-Arguments $tree) @('connect','--root',$RelayRoot,'--config',$ConfigPath,'--name','TB14P-EZRA','--packs','minimal,omp','--update-interval','300')
}
Case 'two independent npx launchers are refused' {
    $tree=@(Normal-Tree)+(Process-Record 80000 1 @{} $true)
    Assert-Throws { Select-RelayLauncherTree $tree } 'Multiple matching'
}
Case 'release worker without its launcher is refused' {
    Assert-Throws { Select-RelayLauncherTree @((Process-Record 2 1 (Runtime-Values))) } 'no verified launcher'
}
Case 'unexpected sibling workers are refused' {
    $tree=@((Process-Record 1 0 @{} $true),(Process-Record 2 1 (Runtime-Values)),(Process-Record 3 1 (Runtime-Values)))
    Assert-Throws { Select-RelayLauncherTree $tree } 'Unexpected relay process topology'
}
Case 'implicit cwd without supervisor evidence is refused' {
    Assert-Throws { Select-RelayLauncherTree @((Process-Record 1 0 @{} $true)) } 'Implicit relay root'
}
Case 'changed root and permissions are refused' {
    $tree=Normal-Tree
    $tree[0].Values['root']='C:\another project'
    Assert-Throws { Select-RelayLauncherTree $tree } 'settings disagree'
    $tree=Normal-Tree
    $tree[2].Values['no-shell']=$true
    Assert-Throws { Select-RelayLauncherTree $tree } 'permissions disagree'
}
Case 'effective packs and runtime flags survive migration without pairing credentials' {
    $values=Runtime-Values
    $values['packs']='minimal,omp,kernel,computer'
    $values['allow-kernel']=$true
    $values['allow-computer']=$true
    $values['no-shell']=$true
    $values['verbose']=$true
    $values['name']='my custom name'
    $values['update-interval']='750'
    $values['update-manifest']='https://relay.cyjin.dev/updates/device/stable.json'
    $rootValues=$values.Clone()
    $rootValues.Remove('no-auto-update')
    $rootValues['code']='ONE-TIME-CODE'
    $tree=Select-RelayLauncherTree @((Process-Record 1 0 $rootValues $true),(Process-Record 2 1 $values.Clone()),(Process-Record 3 2 $values.Clone()))
    $migrated=@(Migration-Arguments $tree)
    foreach ($flag in @('--allow-kernel','--allow-computer','--no-shell','--verbose')) { Assert-Equal ($migrated -contains $flag) $true }
    Assert-Equal ($migrated -contains 'minimal,omp,kernel,computer') $true
    Assert-Equal ($migrated -contains 'my custom name') $true
    Assert-Equal ($migrated -contains '750') $true
    Assert-Equal ($migrated -contains '--code') $false
    Assert-Equal ($migrated -contains 'ONE-TIME-CODE') $false
    Assert-Equal ($migrated -contains '--no-auto-update') $false
}
Case 'explicit opt out survives rollback arguments' {
    $values=Runtime-Values
    $tree=Select-RelayLauncherTree @((Process-Record 1 0 $values $true))
    Assert-Equal (@(Migration-Arguments $tree) -contains '--no-auto-update') $true
}
Case 'identity validation is independent of filtered environment' {
    $source=[IO.File]::ReadAllText($InstallerPath)
    Assert-Equal $source.Contains('$env:COMPUTERNAME') $false
    Assert-Equal $source.Contains('[Environment]::MachineName') $true
    $savedComputer=$env:COMPUTERNAME
    try {
        $env:COMPUTERNAME=''
        Assert-Equal ([Environment]::MachineName.Length -gt 0) $true
    } finally { $env:COMPUTERNAME=$savedComputer }
}

Case 'CIM snapshot recognizes the actual no-argument npx launcher and its workers' {
    $LegacyEntryPoint='C:\Users\ezra\AppData\Local\npm-cache\_npx\71175ae0e040d800\node_modules\@cyjin\mcp-relay\dist\cli.cjs'
    $InstallRoot='C:\Users\ezra\.mcp-relay\managed'
    $bootstrapEntry=Join-Path $InstallRoot 'bootstrap.cjs'
    $identity=[pscustomobject]@{User=[pscustomobject]@{Value='S-1-5-21-test'}}
    $digest='a'*64
    $workerEntry='C:\Users\ezra\.mcp-relay\updates\0123456789abcdef\releases\'+$digest+'\cli.cjs'
    $workerCommand='"node" "'+$workerEntry+'" connect --root C:\Users\ezra --config C:\Users\ezra\.mcp-relay\device.json --name TB14P-EZRA --packs minimal,omp --no-auto-update --update-interval 300'
    $created=[DateTime]'2026-11-24T06:30:00Z'
    $fixtureProcesses=@(
        [pscustomobject]@{ProcessId=67384;ParentProcessId=49812;CreationDate=$created;CommandLine='"node" "C:\Users\ezra\AppData\Local\npm-cache\_npx\71175ae0e040d800\node_modules\.bin\\..\@cyjin\mcp-relay\dist\cli.cjs"'},
        [pscustomobject]@{ProcessId=72040;ParentProcessId=67384;CreationDate=$created;CommandLine=$workerCommand},
        [pscustomobject]@{ProcessId=69756;ParentProcessId=72040;CreationDate=$created;CommandLine=$workerCommand},
        [pscustomobject]@{ProcessId=42;ParentProcessId=1;CreationDate=$created;CommandLine='node C:\unrelated\server.cjs'}
    )
    function Get-CimInstance { param($ClassName,$Filter) return $fixtureProcesses }
    function Invoke-CimMethod { param($InputObject,$MethodName) return [pscustomobject]@{ReturnValue=0;Sid='S-1-5-21-test'} }
    function Hash([string]$Path) { if ($Path -eq $workerEntry) { return $digest }; return ('b'*64) }
    $savedProfile=$env:USERPROFILE
    try {
        $env:USERPROFILE='C:\Users\ezra'
        $processes=@(Owned-RelayProcesses)
        Assert-Equal $processes.Count 3
        $migration=Select-RelayLauncherTree $processes
        $legacy=@()
        if ($null -ne $migration) { $legacy=@($migration.Root) }
        Assert-Equal $legacy.Count 1
        Assert-Equal $legacy[0].Id 67384
        Assert-Equal (@(Migration-Arguments $migration) -contains '--no-auto-update') $false
    } finally { $env:USERPROFILE=$savedProfile }
}
Case 'empty input keeps explicit array shape and null options are implicit connect' {
    Assert-Equal (Relay-Options $null).Command 'connect'
    $legacy=@()
    $migration=Select-RelayLauncherTree @()
    if ($null -ne $migration) { $legacy=@($migration.Root) }
    Assert-Equal $legacy.Count 0
}

Case 'option-like device names remain values while missing update options are added' {
    $ManifestUrl='https://relay.cyjin.dev/updates/device/stable.json'
    $UpdateIntervalSeconds=300
    foreach ($name in @('--update-manifest','--update-interval','--no-auto-update','--custom=device')) {
        $values=Runtime-Values
        $values['name']=$name
        $values.Remove('update-interval')
        $tree=Select-RelayLauncherTree @((Process-Record 1 0 $values $true))
        $previous=@(Migration-Arguments $tree)
        Assert-Equal ($previous -contains ('--name='+$name)) $true
        $managed=@(Managed-Arguments $tree $previous)
        $options=Relay-Options $managed
        Assert-Equal $options.Values['name'] $name
        Assert-Equal $options.Values['update-manifest'] $ManifestUrl
        Assert-Equal $options.Values['update-interval'] '300'
        Assert-Equal $options.Values.ContainsKey('no-auto-update') $false
    }
}
Case 'explicit update options survive managed argument construction once' {
    $ManifestUrl='https://relay.cyjin.dev/updates/device/stable.json'
    $UpdateIntervalSeconds=300
    $values=Runtime-Values
    $values['update-manifest']='https://relay.cyjin.dev/updates/device/preview.json'
    $values['update-interval']='750'
    $tree=Select-RelayLauncherTree @((Process-Record 1 0 $values $true))
    $managed=@(Managed-Arguments $tree @(Migration-Arguments $tree))
    $options=Relay-Options $managed
    Assert-Equal $options.Values['update-manifest'] 'https://relay.cyjin.dev/updates/device/preview.json'
    Assert-Equal $options.Values['update-interval'] '750'
    Assert-Equal @($managed|Where-Object {$_ -eq '--update-manifest'}).Count 1
    Assert-Equal @($managed|Where-Object {$_ -eq '--update-interval'}).Count 1
}

Case 'hidden launcher is a GUI host wrapper with wait and Unicode-safe command quoting' {
    $program='C:\Program Files\Node\node.exe'
    $arguments=@('C:\用户\relay\cli.cjs','connect','--name','a "quoted" name','--root','C:\with spaces\')
    $command=@((@($program)+$arguments)|ForEach-Object {Windows-Quote $_}) -join ' '
    Assert-Equal @(Split-WindowsCommandLine $command) (@($program)+$arguments)
    $hidden=Hidden-Launcher $program $arguments 'C:\用户\workspace'
    Assert-Equal $hidden.Contains('shell.Run(') $true
    Assert-Equal $hidden.Contains(', 0, True)') $true
    Assert-Equal $hidden.Contains('WScript.Quit exitCode') $true
    Assert-Equal $hidden.Contains('用户') $true
    Assert-Throws {Hidden-Launcher 'C:\%INJECTED%\node.exe' @() 'C:\safe'} 'environment expansion'
}
Case 'managed task and rollback use WScript GUI entry rather than a console executable' {
    $source=[IO.File]::ReadAllText($InstallerPath)
    Assert-Equal $source.Contains('New-ScheduledTaskAction -Execute $windowsScriptHost') $true
    Assert-Equal $source.Contains('Start-Process -FilePath $windowsScriptHost') $true
    Assert-Equal $source.Contains('Assert-HiddenLauncherAvailable') $true
    Assert-Equal $source.Contains('[Text.Encoding]::Unicode)') $true
    Assert-Equal $source.Contains('New-ScheduledTaskAction -Execute $windowsPowerShell') $false
}


Case 'AddComputer defaults off and does not change a minimal omp managed target' {
    $ManifestUrl='https://relay.cyjin.dev/updates/device/stable.json'; $UpdateIntervalSeconds=300
    $tree=Select-RelayLauncherTree (Normal-Tree)
    $before=@(Migration-Arguments $tree)
    $managed=@(Managed-Arguments $tree $before)
    Assert-Equal (Relay-Options $managed).Values['packs'] 'minimal,omp'
    Assert-Equal ((Relay-Options $managed).Values.ContainsKey('allow-computer')) $false
    Assert-Equal @(Migration-Arguments $tree) $before
}
Case 'explicit AddComputer unions existing packs without changing rollback arguments' {
    $AddComputer=$true
    $ManifestUrl='https://relay.cyjin.dev/updates/device/stable.json'; $UpdateIntervalSeconds=300
    $tree=Select-RelayLauncherTree (Normal-Tree)
    $previous=@(Migration-Arguments $tree); $saved=@($previous)
    $target=@(Managed-Arguments $tree $previous)
    Assert-Equal (Relay-Options $target).Values['packs'] 'minimal,omp,computer'
    Assert-Equal (Relay-Options $target).Values['allow-computer'] $true
    Assert-Equal $previous $saved
    Assert-Equal @(Migration-Arguments $tree) $saved
    Assert-Equal $tree.Values['packs'] 'minimal,omp'
}
Case 'computer union is idempotent and preserves kernel permissions and option-like names' {
    $original=@('connect','--packs=kernel,computer,minimal,omp','--allow-kernel','--allow-computer','--no-shell','--verbose','--name=--x','--update-interval','750')
    Assert-Equal @(Add-ComputerArguments $original) $original
    $withValue=@('connect','--name','--packs','--packs','minimal,kernel','--allow-kernel')
    $target=@(Add-ComputerArguments $withValue)
    Assert-Equal (Relay-Options $target).Values['name'] '--packs'
    Assert-Equal (Relay-Options $target).Values['packs'] 'minimal,kernel,computer'
    Assert-Equal (Relay-Options $target).Values['allow-kernel'] $true
    Assert-Equal @(Add-ComputerArguments $target) $target
}
Case 'unknown options are refused before a computer target can be installed' {
    $unknown=@('connect','--packs','minimal,omp','--future-permission')
    $original=@($unknown)
    Assert-Throws { Add-ComputerArguments $unknown } 'Unknown'
    Assert-Equal $unknown $original
}
function Activation-Fixture([bool]$Explicit=$false) {
    $values=Runtime-Values
    if ($Explicit) { $values['packs']='minimal,omp,computer'; $values['allow-computer']=$true }
    $processes=@((Process-Record 1 0 $values.Clone() $false $true),(Process-Record 2 1 $values.Clone()),(Process-Record 3 2 $values.Clone()))
    foreach ($process in $processes) {
        $process | Add-Member -NotePropertyName EntrySha256 -NotePropertyValue ('a'*64)
        $process | Add-Member -NotePropertyName CreatedAt -NotePropertyValue '2026-11-25T01:00:00.000Z'
    }
    return @{
        Processes=$processes
        Settings=[pscustomobject]@{schema=1;enabled=$true;paused=$true;revision='enabled-revision';updatedAt='2026-11-25T00:59:00.000Z'}
        Status=[pscustomobject]@{phase='running';sha256=('a'*64);version='0.1.12';supervisorVersion='0.1.12';updatedAt=1795568401000;reload=[pscustomobject]@{status='completed';requestKey='enabled-revision'}}
        Commands=(New-Object 'Collections.Generic.List[string]')
    }
}
Case 'completed same-revision reload proves implicit computer with a ready same-bundle worker' {
    $ExpectedSha256='a'*64; $version='0.1.12'; $fixture=Activation-Fixture
    function Owned-RelayProcesses { return $fixture.Processes }
    function Read-Status { return $fixture.Status }
    function Invoke-ComputerControl { param($Command,$DefaultEnabled) $fixture.Commands.Add($Command); return $fixture.Settings }
    $result=Read-ComputerActivation @('minimal','omp','computer')
    Assert-Equal $result.complete $true
    Assert-Equal $result.reloadRevisionVerified $true
    Assert-Equal $result.paused $true
    Assert-Equal $result.registrationVerified $false
    Assert-Equal $result.workerPid 3
    Assert-Equal $result.effectivePacks @('minimal','omp','computer')
}
Case 'stale reload or status cannot claim a newly enabled implicit pack' {
    $ExpectedSha256='a'*64; $version='0.1.12'; $fixture=Activation-Fixture
    $fixture.Settings.updatedAt='2026-11-25T01:01:00.000Z'
    $fixture.Status.reload.requestKey='old-revision'
    function Owned-RelayProcesses { return $fixture.Processes }
    function Read-Status { return $fixture.Status }
    function Invoke-ComputerControl { param($Command,$DefaultEnabled) return $fixture.Settings }
    $result=Read-ComputerActivation @('minimal','omp','computer')
    Assert-Equal $result.enabled $true
    Assert-Equal $result.complete $false
    Assert-Equal $result.workerPackVerified $false
    $fixture.Status.reload.requestKey='enabled-revision'
    $fixture.Status.updatedAt=0
    Assert-Equal (Read-ComputerActivation @('minimal','omp','computer')).complete $false
    $fixture.Status.updatedAt=1795568401000
    $fixture.Processes[2].EntrySha256='b'*64
    Assert-Equal (Read-ComputerActivation @('minimal','omp','computer')).complete $false
}
Case 'explicitly registered computer remains complete after a local pause revision change' {
    $ExpectedSha256='a'*64; $version='0.1.12'; $fixture=Activation-Fixture $true
    $fixture.Settings.revision='pause-revision'
    $fixture.Settings.updatedAt='2026-11-25T01:01:00.000Z'
    function Owned-RelayProcesses { return $fixture.Processes }
    function Read-Status { return $fixture.Status }
    function Invoke-ComputerControl { param($Command,$DefaultEnabled) return $fixture.Settings }
    $result=Read-ComputerActivation @('minimal','omp','computer')
    Assert-Equal $result.complete $true
    Assert-Equal $result.paused $true
    Assert-Equal $result.reloadRevisionVerified $false
}
Case 'enable is invoked once for a disabled sidecar and never resumes local pause' {
    $HealthTimeoutSeconds=0
    $fixture=@{Enabled=$false;Commands=(New-Object 'Collections.Generic.List[string]')}
    function Read-ComputerActivation {
        return [ordered]@{enabled=$fixture.Enabled;paused=$true;complete=$fixture.Enabled;workerPackVerified=$fixture.Enabled}
    }
    function Invoke-ComputerControl {
        param($Command)
        $fixture.Commands.Add($Command); $fixture.Enabled=$true
        return [pscustomobject]@{schema=1;enabled=$true;paused=$true}
    }
    $first=Ensure-ComputerActivation @('minimal','omp','computer')
    Assert-Equal $first.complete $true
    Assert-Equal $first.enableInvoked $true
    Assert-Equal $first.paused $true
    $retry=Ensure-ComputerActivation @('minimal','omp','computer')
    Assert-Equal $retry.complete $true
    Assert-Equal $retry.enableInvoked $false
    Assert-Equal $fixture.Commands.ToArray() @('computer-enable')
}
Case 'busy safe-drain activation remains pending and retry does not replay enable' {
    $HealthTimeoutSeconds=0
    $fixture=@{Enabled=$false;Commands=(New-Object 'Collections.Generic.List[string]')}
    function Read-ComputerActivation { return [ordered]@{enabled=$fixture.Enabled;paused=$true;complete=$false;workerPackVerified=$false} }
    function Invoke-ComputerControl {
        param($Command)
        $fixture.Commands.Add($Command); $fixture.Enabled=$true
        return [pscustomobject]@{schema=1;enabled=$true;paused=$true}
    }
    $result=Ensure-ComputerActivation @('minimal','omp','computer')
    Assert-Equal $result.complete $false
    Assert-Equal $result.enableInvoked $true
    Assert-Equal $result.paused $true
    $retry=Ensure-ComputerActivation @('minimal','omp','computer')
    Assert-Equal $retry.complete $false
    Assert-Equal $retry.enableInvoked $false
    Assert-Equal $fixture.Commands.ToArray() @('computer-enable')
    Assert-Equal ($retry.reason -match 'safely drained') $true
}
Case 'already-managed opt-in applies startup target before activation and retains installation on pending' {
    $tree=Select-RelayLauncherTree (Normal-Tree); $task=[pscustomobject]@{Name='fixture'}
    $report=[ordered]@{}; $calls=New-Object 'Collections.Generic.List[string]'
    function Update-ComputerTaskAction { param($Task,$Tree) $calls.Add('task'); return $true }
    function Ensure-ComputerActivation {
        param([string[]]$RequiredPacks)
        Assert-Equal $RequiredPacks @('minimal','omp','computer')
        $calls.Add('activate')
        return [ordered]@{enabled=$true;paused=$true;complete=$false;reason='safe drain pending'}
    }
    Assert-Throws { Complete-ComputerOptIn $tree $task } 'safe drain pending'
    Assert-Equal $calls.ToArray() @('task','activate')
    Assert-Equal $report.installationCommitted $true
    Assert-Equal $report.computer.complete $false
    Assert-Equal $report.computer.paused $true
}
function Task-Fixture {
    return [pscustomobject]@{
        Task=[pscustomobject]@{Actions=@([pscustomobject]@{Execute=$NodePath;Arguments='"previous.cjs" connect --packs minimal,omp';WorkingDirectory=$RelayRoot})}
        SetCount=0; CorruptFirstWrite=$false
    }
}
Case 'managed task computer target is hidden, backed up, verified and idempotent without restart' {
    $AddComputer=$true; $ManifestUrl='https://relay.cyjin.dev/updates/device/stable.json'; $UpdateIntervalSeconds=300
    $InstallRoot=Join-Path ([IO.Path]::GetTempPath()) ('relay-task-test-'+[Guid]::NewGuid().ToString('N'))
    $NodePath=Join-Path $InstallRoot 'node.exe'; $bootstrapEntry=Join-Path $InstallRoot 'bootstrap.cjs'
    $windowsScriptHost=Join-Path $InstallRoot 'wscript.exe'; $windowsPowerShell=Join-Path $InstallRoot 'powershell.exe'; $TaskName='fixture'
    $report=[ordered]@{}; $fixture=Task-Fixture; $original=$fixture.Task; $tree=Select-RelayLauncherTree (Normal-Tree)
    function Existing-Task { return $fixture.Task }
    function Export-ScheduledTask { param($TaskPath,$TaskName) return '<Task>original-argv</Task>' }
    function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) return [pscustomobject]@{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory} }
    function Set-ScheduledTask { param($TaskPath,$TaskName,$Action) $fixture.SetCount++; $fixture.Task=[pscustomobject]@{Actions=@($Action)} }
    function Stop-Process { throw 'A managed opt-in must not stop a process' }
    function Stop-ScheduledTask { throw 'A managed opt-in must not stop its task' }
    function Start-ScheduledTask { throw 'A managed opt-in must not restart its task' }
    try {
        Assert-Equal (Update-ComputerTaskAction $original $tree) $true
        Assert-Equal $fixture.SetCount 1
        Assert-Equal ([IO.File]::ReadAllText($report.taskActionBackup)) '<Task>original-argv</Task>'
        Assert-Equal (Hash $report.taskActionBackup) $report.taskActionBackupSha256
        $hidden=@(Split-WindowsCommandLine $fixture.Task.Actions[0].Arguments)[2]
        $content=[IO.File]::ReadAllText($hidden)
        Assert-Equal $content.Contains(', 0, True)') $true
        $encoded=[regex]::Match($content,'-EncodedCommand"" ""([^"]+)""').Groups[1].Value
        $script=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
        Assert-Equal $script.Contains("'minimal,omp,computer'") $true
        Assert-Equal $script.Contains("'--allow-computer'") $true
        Assert-Equal (Update-ComputerTaskAction $fixture.Task $tree) $false
        Assert-Equal $fixture.SetCount 1
    } finally { if (Test-Path -LiteralPath $InstallRoot) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force } }
}
Case 'failed computer task readback restores the exact previous action' {
    $AddComputer=$true; $ManifestUrl='https://relay.cyjin.dev/updates/device/stable.json'; $UpdateIntervalSeconds=300
    $InstallRoot=Join-Path ([IO.Path]::GetTempPath()) ('relay-task-test-'+[Guid]::NewGuid().ToString('N'))
    $NodePath=Join-Path $InstallRoot 'node.exe'; $bootstrapEntry=Join-Path $InstallRoot 'bootstrap.cjs'
    $windowsScriptHost=Join-Path $InstallRoot 'wscript.exe'; $windowsPowerShell=Join-Path $InstallRoot 'powershell.exe'; $TaskName='fixture'
    $report=[ordered]@{}; $fixture=Task-Fixture; $original=$fixture.Task; $tree=Select-RelayLauncherTree (Normal-Tree)
    function Existing-Task { return $fixture.Task }
    function Export-ScheduledTask { param($TaskPath,$TaskName) return '<Task>exact-original</Task>' }
    function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) return [pscustomobject]@{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory} }
    function Set-ScheduledTask {
        param($TaskPath,$TaskName,$Action)
        $fixture.SetCount++; $fixture.Task=[pscustomobject]@{Actions=@($Action)}
        if ($fixture.SetCount -eq 1) {
            $hidden=@(Split-WindowsCommandLine $Action.Arguments)[2]
            [IO.File]::WriteAllText($hidden,'readback mismatch')
        }
    }
    try {
        Assert-Throws { Update-ComputerTaskAction $original $tree } 'did not read back exactly'
        Assert-Equal $fixture.SetCount 2
        Assert-Equal (Same-TaskAction $fixture.Task $original) $true
        Assert-Equal ([IO.File]::ReadAllText($report.taskActionBackup)) '<Task>exact-original</Task>'
    } finally { if (Test-Path -LiteralPath $InstallRoot) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force } }
}

$passed=@($results|Where-Object {-not $_.passed}).Count -eq 0
[ordered]@{passed=$passed;cases=$results.ToArray();powershell=$PSVersionTable.PSVersion.ToString()}|ConvertTo-Json -Depth 8
if (-not $passed) { exit 1 }
exit 0
