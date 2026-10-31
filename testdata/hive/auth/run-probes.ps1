param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('binary-gssapi', 'http-spnego', 'binary-gssapi-tls', 'http-spnego-tls')]
    [string]$Stage,
    [string]$PrivateDirectory = (Join-Path ([System.IO.Path]::GetTempPath()) 'gonavi-hive-1584-auth')
)
$ErrorActionPreference = 'Stop'
$probe = Join-Path ([System.IO.Path]::GetTempPath()) 'gonavi-hive-1584-auth-probe.exe'
if (-not (Test-Path -LiteralPath $probe -PathType Leaf)) { throw 'Build the scoped authentication probe first.' }
$output = Join-Path $PrivateDirectory ("evidence-${Stage}.jsonl")
$cases = @('keytab', 'password', 'ccache', 'wrong-password', 'keytab-wrong-spn', 'no-auth')
if ($Stage.EndsWith('-tls')) { $cases += @('keytab-untrusted', 'keytab-hostname') }
[System.IO.File]::WriteAllText($output, '')
foreach ($case in $cases) {
    $configuration = Join-Path $PrivateDirectory ("${Stage}-${case}.json")
    $lines = @(& $probe -config $configuration)
    $exitCode = $LASTEXITCODE
    $text = $lines -join "`n"
    try { $result = $text | ConvertFrom-Json } catch { throw 'Probe did not return the expected sanitized JSON.' }
    [System.IO.File]::AppendAllText($output, $text + "`n")
    Write-Output $text
    if ($exitCode -ne 0 -or -not $result.passed) { throw "Real Hive authentication case failed: $($result.name)" }
}
Write-Output "Phase passed; private sanitized evidence: $output"
