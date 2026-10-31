param(
    [string]$SshAlias = 'Bero-6H16-DE',
    [int]$KdcPort = 21188,
    [int]$KpasswdPort = 22464,
    [int]$BinaryPort = 21084,
    [int]$HttpPort = 21085
)
$ErrorActionPreference = 'Stop'
$lab = Join-Path ([System.IO.Path]::GetTempPath()) 'gonavi-hive-1584-auth'
New-Item -ItemType Directory -Force -Path $lab | Out-Null
& icacls $lab /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to restrict private TEMP directory ACL.' }
$remote = '/opt/gonavi-db-lab/hive-1584/auth/private'
foreach ($relative in @('client/gonavi.keytab', 'client/gonavi.password', 'client/gonavi.ccache', 'hive/ca.crt', 'hive/untrusted-ca.crt')) {
    & scp -q "${SshAlias}:${remote}/${relative}" (Join-Path $lab (Split-Path $relative -Leaf))
    if ($LASTEXITCODE -ne 0) { throw 'Private fixture download failed; no contents were displayed.' }
}
$krb5 = (Get-Content -Raw (Join-Path $PSScriptRoot 'krb5-client.conf.in')).Replace('@KDC_PORT@', "$KdcPort").Replace('@KPASSWD_PORT@', "$KpasswdPort")
[System.IO.File]::WriteAllText((Join-Path $lab 'krb5.conf'), $krb5)
$wrongPassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
[System.IO.File]::WriteAllText((Join-Path $lab 'wrong.password'), $wrongPassword)
Remove-Variable wrongPassword

function Write-ProbeConfig {
    param([string]$Stage, [string]$Credential, [string]$Expectation = 'success', [string]$Suffix = '')
    $isHttp = $Stage.StartsWith('http')
    $isTLS = $Stage.EndsWith('-tls')
    $service = if ($isHttp) { 'HTTP' } else { 'hive' }
    $port = if ($isHttp) { $HttpPort } else { $BinaryPort }
    $parameters = [ordered]@{
        authMode = 'KERBEROS'
        transportMode = $(if ($isHttp) { 'http' } else { 'binary' })
        principal = "${service}/hive.gonavi.test@GONAVI.TEST"
        realm = 'GONAVI.TEST'
        krb5Config = (Join-Path $lab 'krb5.conf')
    }
    $passwordFile = ''
    switch ($Credential) {
        'keytab' { $parameters['keytab'] = Join-Path $lab 'gonavi.keytab' }
        'ccache' { $parameters['credentialCache'] = 'FILE:' + (Join-Path $lab 'gonavi.ccache') }
        'password' { $passwordFile = Join-Path $lab 'gonavi.password' }
        'wrong-password' { $passwordFile = Join-Path $lab 'wrong.password' }
        'no-auth' { $parameters['authMode'] = 'NONE' }
        default { throw 'Unsupported probe credential mode.' }
    }
    if ($Expectation -eq 'service-principal-rejected') { $parameters['principal'] = "missing/hive.gonavi.test@GONAVI.TEST" }
    $query = ($parameters.GetEnumerator() | ForEach-Object { [uri]::EscapeDataString($_.Key) + '=' + [uri]::EscapeDataString([string]$_.Value) }) -join '&'
    $config = [ordered]@{
        name = "${Stage}-${Credential}${Suffix}"
        connection = [ordered]@{
            type = 'hive'; host = '127.0.0.1'; port = $port; user = 'gonavi@GONAVI.TEST'
            database = 'default'; timeout = 30; queryTimeout = 30; connectionParams = $query
            useSSL = $isTLS; sslMode = 'required'; sslCaPath = (Join-Path $lab 'ca.crt')
        }
        passwordFile = $passwordFile
        expectedUser = 'gonavi'
        expect = $Expectation
    }
    if ($Expectation -eq 'tls-untrusted') { $config.connection.sslCaPath = Join-Path $lab 'untrusted-ca.crt' }
    if ($Expectation -eq 'tls-hostname') { $config.connection.host = '127.0.0.2' }
    [System.IO.File]::WriteAllText((Join-Path $lab ($config.name + '.json')), ($config | ConvertTo-Json -Depth 6))
}

foreach ($stage in @('binary-gssapi', 'http-spnego', 'binary-gssapi-tls', 'http-spnego-tls')) {
    foreach ($credential in @('keytab', 'password', 'ccache')) { Write-ProbeConfig $stage $credential }
    Write-ProbeConfig $stage 'wrong-password' 'kdc-preauth-rejected'
    Write-ProbeConfig $stage 'keytab' 'service-principal-rejected' '-wrong-spn'
    Write-ProbeConfig $stage 'no-auth' 'hs2-auth-rejected'
    if ($stage.EndsWith('-tls')) {
        Write-ProbeConfig $stage 'keytab' 'tls-untrusted' '-untrusted'
        Write-ProbeConfig $stage 'keytab' 'tls-hostname' '-hostname'
    }
}
Write-Output "Private fixture directory: $lab"
Write-Output 'No SSH/DNS/global configuration was changed; start only separately managed temporary forwards.'
