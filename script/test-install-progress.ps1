# Invoke-IrisDownload — the installer's download, and the progress it prints while it runs.
#
# WHY THIS EXISTS. The installer silenced PowerShell's progress bar on purpose ("the progress
# bar makes this ~10x slower" — true on PS 5.1, where Write-Progress repaints per byte), which
# left a multi-megabyte download printing NOTHING. Measured on a client's Windows machine
# 2026-09-22: the install worked, took minutes, and looked hung — they reported it as stuck,
# and it reached a person who had to debug it.
#
# So the download now streams and prints its own progress. These run against a real local HTTP
# server, because the two cases that matter are a server that declares Content-Length and one
# that does not, and a mock cannot tell you which branch you wrote.
#
# Run: pwsh -NoProfile -File script/test-install-progress.ps1

$ErrorActionPreference = "Stop"
$script:Pass = 0
$script:Fail = 0
function Assert($name, $cond, $detail) {
    if ($cond) { $script:Pass++; Write-Host "  PASS  $name" -ForegroundColor Green }
    else { $script:Fail++; Write-Host "  FAIL  $name $(if ($detail) { "- $detail" })" -ForegroundColor Red }
}

# Load the function under test out of the installer without running the installer.
$InstallPs1 = Join-Path $PSScriptRoot "..\install.ps1"
$src = Get-Content -Raw $InstallPs1
$fn = [regex]::Match($src, '(?ms)^function Invoke-IrisDownload \{.*?^\}')
if (-not $fn.Success) {
    Write-Host "  FAIL  install.ps1 defines Invoke-IrisDownload" -ForegroundColor Red
    exit 1
}
. ([scriptblock]::Create($fn.Value))

# A local server: /sized declares Content-Length, /chunked does not.
$Port = 8791
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
$payload = [byte[]]::new(3 * 1024 * 1024)   # 3 MB, big enough to tick more than once
(New-Object Random 7).NextBytes($payload)

$server = Start-ThreadJob -ScriptBlock {
    param($listener, $payload)
    while ($listener.IsListening) {
        try { $ctx = $listener.GetContext() } catch { break }
        $res = $ctx.Response
        if ($ctx.Request.Url.AbsolutePath -eq "/chunked") {
            $res.SendChunked = $true
        } else {
            $res.ContentLength64 = $payload.Length
        }
        # Written in slices so a reader sees more than one chunk.
        $chunk = 256 * 1024
        for ($i = 0; $i -lt $payload.Length; $i += $chunk) {
            $n = [Math]::Min($chunk, $payload.Length - $i)
            $res.OutputStream.Write($payload, $i, $n)
            $res.OutputStream.Flush()
        }
        $res.OutputStream.Close()
    }
} -ArgumentList $listener, $payload

try {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("iris-dl-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp | Out-Null

    # ---- a download that declares its size --------------------------------------------
    $out = Join-Path $tmp "sized.bin"
    $printed = & { $r = Invoke-IrisDownload -Url "http://localhost:$Port/sized" -OutFile $out -Label "Downloading iris"; $script:res = $r } 6>&1 | Out-String

    Assert "reports success" ($script:res.Ok -eq $true) $script:res.Reason
    Assert "writes the whole file" ((Get-Item $out).Length -eq $payload.Length) "$((Get-Item $out).Length) of $($payload.Length)"
    Assert "bytes are intact" (@(Compare-Object ([System.IO.File]::ReadAllBytes($out)) $payload -SyncWindow 0).Count -eq 0)
    Assert "returns the byte count" ($script:res.Bytes -eq $payload.Length) "$($script:res.Bytes)"
    # The whole point: a person watching must see it moving, with a total to measure against.
    Assert "prints the label" ($printed -match "Downloading iris") $printed
    Assert "prints megabytes, not bytes" ($printed -match "\d+(\.\d+)?\s*MB") $printed
    Assert "prints a percentage when the size is known" ($printed -match "\d+%") $printed

    # ---- a download with no declared size ---------------------------------------------
    $out2 = Join-Path $tmp "chunked.bin"
    $printed2 = & { $r = Invoke-IrisDownload -Url "http://localhost:$Port/chunked" -OutFile $out2 -Label "Downloading daemon"; $script:res2 = $r } 6>&1 | Out-String

    Assert "chunked: succeeds" ($script:res2.Ok -eq $true) $script:res2.Reason
    Assert "chunked: writes the whole file" ((Get-Item $out2).Length -eq $payload.Length)
    # No total is known, so a percentage would be invented. It must count up instead.
    Assert "chunked: still shows movement" ($printed2 -match "\d+(\.\d+)?\s*MB") $printed2
    Assert "chunked: invents no percentage" ($printed2 -notmatch "\d+%") $printed2

    # ---- a dead URL is a RESULT, never an exception -----------------------------------
    $out3 = Join-Path $tmp "nope.bin"
    $script:res3 = Invoke-IrisDownload -Url "http://localhost:$Port/../nowhere-at-all" -OutFile $out3 -Label "x" 6>&1 | Out-Null
    $script:res3 = Invoke-IrisDownload -Url "http://localhost:9/none" -OutFile $out3 -Label "x" 6>$null
    Assert "an unreachable host returns Ok=false with a reason" (($script:res3.Ok -eq $false) -and $script:res3.Reason) "$($script:res3 | ConvertTo-Json -Compress)"
    Assert "and leaves no half-written file behind" (-not (Test-Path $out3))

    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
} finally {
    $listener.Stop()
    $listener.Close()
    Stop-Job $server -ErrorAction SilentlyContinue | Out-Null
    Remove-Job $server -Force -ErrorAction SilentlyContinue | Out-Null
}

Write-Host ""
Write-Host "  $script:Pass passed, $script:Fail failed"
exit $(if ($script:Fail) { 1 } else { 0 })
