[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$BundlePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
    [Parameter(Mandatory=$true)][string]$HarnessPath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$HarnessSha256,
    [string]$NodePath = "$env:APPDATA\fnm\node-versions\v24.14.0\installation\node.exe",
    [string]$ExpectedComputerName = 'TB14P-EZRA',
    [Parameter(Mandatory=$true)][string]$ReceiptPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Save-Json([string]$Path, $Object) {
    $parent = Split-Path -Parent ([IO.Path]::GetFullPath($Path))
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, ($Object | ConvertTo-Json -Depth 15), (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path) {
        [IO.File]::Replace($temporary, $Path, ($Path + '.previous-' + [Guid]::NewGuid().ToString('N')))
    } else { [IO.File]::Move($temporary, $Path) }
}
$report = [ordered]@{ schemaVersion=1; passed=$false; computerName=[Environment]::MachineName; startedAt=[DateTime]::UtcNow.ToString('o') }
try {
    if ([Environment]::MachineName -ine $ExpectedComputerName) { throw 'Unexpected computer identity; no test processes started' }
    if ($NodePath -match '[\\/]fnm_multishells[\\/]') { throw 'Use the stable Node installation, not an ephemeral fnm multishell path' }
    foreach ($path in @($NodePath,$BundlePath,$HarnessPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('Required file is unavailable: ' + $path) }
    }
    if ((Hash $BundlePath) -ne $ExpectedSha256.ToLowerInvariant()) { throw 'CLI artifact SHA-256 mismatch' }
    if ((Hash $HarnessPath) -ne $HarnessSha256.ToLowerInvariant()) { throw 'Acceptance harness SHA-256 mismatch' }
    $arguments = @($HarnessPath,$BundlePath)
    $captured = @(& $NodePath @arguments)
    $exitCode = $LASTEXITCODE
    $result = (($captured -join [Environment]::NewLine) | ConvertFrom-Json)
    if ($exitCode -ne 0 -or $result.passed -ne $true) { throw 'Windows loopback acceptance failed; preserved harness evidence identifies the failing case' }
    if ($result.platform -ne 'win32' -or $result.computerName -ine $ExpectedComputerName) { throw 'Acceptance receipt identity mismatch' }
    if ($result.bundleSha256 -ne $ExpectedSha256.ToLowerInvariant()) { throw 'Acceptance ran a different CLI artifact' }
    if (@($result.cases).Count -ne 10 -or @($result.cases | Where-Object { $_.passed -ne $true }).Count -ne 0) { throw 'Incomplete acceptance results' }
    # Bind the harness result to the verified runner bytes and SSH account.
    $result | Add-Member -NotePropertyName harnessSha256 -NotePropertyValue $HarnessSha256.ToLowerInvariant() -Force
    $result | Add-Member -NotePropertyName verifiedIdentity -NotePropertyValue ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -Force
    Save-Json $ReceiptPath $result
    [ordered]@{ passed=$true; receipt=$ReceiptPath; computerName=$result.computerName; version=$result.deviceVersion; bundleSha256=$result.bundleSha256; evidence=$result.evidence } | ConvertTo-Json -Compress
    exit 0
} catch {
    $report.error = $_.Exception.Message
    $report.completedAt = [DateTime]::UtcNow.ToString('o')
    Save-Json ($ReceiptPath + '.failure-' + [Guid]::NewGuid().ToString('N') + '.json') $report
    $report | ConvertTo-Json -Compress
    exit 1
}
