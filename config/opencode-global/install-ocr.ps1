#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$RepoRoot = 'C:\Users\Admin\Soc_brain',
    [string]$TaskWorktree = 'C:\Users\Admin\Soc_brain\worktrees\task\affected-test-gate-unified-manifest-and-verifier-20261012-204117',
    [switch]$PolicyOnly
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
function Get-BytesHash([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '') } finally { $sha.Dispose() }
}
$pluginSource = Join-Path $PSScriptRoot 'plugins\open-code-review.ts'
$policySource = Join-Path $PSScriptRoot 'internal-review-chain.md'
$pluginTarget = Join-Path $env:USERPROFILE '.config\opencode\plugins\open-code-review.ts'
$buildTargets = @(
    (Join-Path $env:USERPROFILE '.config\opencode\agents\build.md')
    (Join-Path $RepoRoot '.opencode\agents\build.md')
)
if ($TaskWorktree) { $buildTargets += Join-Path $TaskWorktree '.opencode\agents\build.md' }
$policy = [IO.File]::ReadAllText($policySource, $utf8).TrimEnd()
$begin = '<!-- SOC_INTERNAL_REVIEW_CHAIN_V2 -->'
$end = '<!-- END_SOC_INTERNAL_REVIEW_CHAIN_V2 -->'
$pattern = '(?s)' + [regex]::Escape($begin) + '.*?' + [regex]::Escape($end)
$changes = [Collections.Generic.List[object]]::new()
$newHash = $null
if (-not $PolicyOnly) {
    $pluginBytes = [IO.File]::ReadAllBytes($pluginSource)
    $pluginOriginal = [IO.File]::ReadAllBytes($pluginTarget)
    $oldHash = Get-BytesHash $pluginOriginal
    $newHash = Get-BytesHash $pluginBytes
    $knownStub = 'D9CD3EFE18A06E931B89A875752C35DCD9CEB4D2B47DA168E3E95934409D058A'
    if ($oldHash -cne $newHash -and $oldHash -cne $knownStub) {
        throw "OCR plugin changed from the inspected stub; refusing overwrite. SHA256=$oldHash"
    }
    if ($oldHash -cne $newHash) {
        $changes.Add([pscustomobject]@{Path=$pluginTarget; Before=$pluginOriginal; After=$pluginBytes; Backup=''; Written=$false})
    }
}
foreach ($path in ($buildTargets | Select-Object -Unique)) {
    $before = [IO.File]::ReadAllBytes($path)
    $text = $utf8.GetString($before)
    $beginCount = [regex]::Matches($text, [regex]::Escape($begin)).Count
    $endCount = [regex]::Matches($text, [regex]::Escape($end)).Count
    if ($beginCount -ne $endCount -or $beginCount -gt 1) { throw "Malformed managed policy: $path" }
    $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $block = $policy.Replace("`r`n", "`n").Replace("`n", $newline)
    if ($beginCount -eq 1) {
        if ([regex]::Matches($text, $pattern).Count -ne 1) { throw "Invalid marker order: $path" }
        $updated = [regex]::Replace($text, $pattern, [Text.RegularExpressions.MatchEvaluator]{ param($match) $block })
    } else { $updated = $text.TrimEnd() + $newline + $newline + $block + $newline }
    $after = $utf8.GetBytes($updated)
    if ((Get-BytesHash $before) -cne (Get-BytesHash $after)) {
        $changes.Add([pscustomobject]@{Path=$path; Before=$before; After=$after; Backup=''; Written=$false})
    }
}
if ($changes.Count -eq 0) {
    Write-Host 'ALREADY INSTALLED + VERIFIED. Runtime activation is not verified.'
    return
}
$backupDir = Join-Path ([IO.Path]::GetTempPath()) ('soc-ocr-v2-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($backupDir)
$index = 0
foreach ($change in $changes) {
    $index++
    $change.Backup = Join-Path $backupDir "$index.bak"
    [IO.File]::WriteAllBytes($change.Backup, $change.Before)
}
$manifest = @($changes | ForEach-Object { @{Original=$_.Path; Backup=$_.Backup; BeforeSHA256=(Get-BytesHash $_.Before); AfterSHA256=(Get-BytesHash $_.After)} })
[IO.File]::WriteAllText((Join-Path $backupDir 'manifest.json'), (ConvertTo-Json -InputObject $manifest -Depth 4), $utf8)
try {
    foreach ($change in $changes) {
        if ((Get-BytesHash ([IO.File]::ReadAllBytes($change.Path))) -cne (Get-BytesHash $change.Before)) { throw "File changed after preflight: $($change.Path)" }
        $change.Written = $true
        [IO.File]::WriteAllBytes($change.Path, $change.After)
        if ((Get-BytesHash ([IO.File]::ReadAllBytes($change.Path))) -cne (Get-BytesHash $change.After)) { throw "Readback mismatch: $($change.Path)" }
        Write-Host "UPDATED + VERIFIED: $($change.Path)"
    }
} catch {
    $failure = $_
    foreach ($change in $changes) {
        if ($change.Written) { [IO.File]::WriteAllBytes($change.Path, $change.Before) }
    }
    throw "Install failed; written files restored. BACKUP=$backupDir; ERROR=$failure"
}
Write-Host "BACKUP: $backupDir"
if (-not $PolicyOnly) { Write-Host "OCR SOURCE SHA256: $newHash" }
Write-Host 'FILES VERIFIED. Server was not restarted. Next checkpoint: activation, ocr_health, preview, bounded review and cancellation on Windows.'
