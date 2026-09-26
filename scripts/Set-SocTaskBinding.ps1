<#
.SYNOPSIS
    Set-SocTaskBinding.ps1 - Tien ich quan tri nan dong Session Binding cho Soc_brain.
.DESCRIPTION
    Dinh vi session trong .soc-brain/state/sessions theo repo va issueNumber,
    sao luu du phong (.bak) va cap nhat prNumber, headSha, worktreePath.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Repo,

    [Parameter(Mandatory = $true)]
    [int]$Issue,

    [int]$PrNumber = 0,
    [string]$HeadSha = '',
    [string]$WorktreePath = '',
    [string]$StateDir = '',
    [switch]$DryRun
)

Set-StrictMode -Version 3.0;
$ErrorActionPreference = 'Stop';

$actualStateDir =$StateDir;
if ([string]::IsNullOrWhiteSpace($actualStateDir)) {
    $actualStateDir = Join-Path -Path$HOME -ChildPath '.soc-brain\state';
}

$sessionsDir = Join-Path -Path$actualStateDir -ChildPath 'sessions';
if (-not (Test-Path -LiteralPath $sessionsDir)) {
    Write-Error "Thu muc sessions khong ton tai: $sessionsDir";
    return;
}

$sessionFiles = @(Get-ChildItem -LiteralPath$sessionsDir -Filter '*.json' -File -ErrorAction SilentlyContinue);
$targetFile =$null;
$targetSession =$null;

for ($i = 0; $i -lt $sessionFiles.Count; $i++) {
    $f = $sessionFiles[$i];
    try {
        $raw = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8);
        $json = ConvertFrom-Json -InputObject$raw -AsHashtable;
        if ($json.ContainsKey('repo') -and$json['repo'] -eq $Repo -and$json.ContainsKey('issueNumber') -and ([int]$json['issueNumber']) -eq$Issue) {
            $targetFile =$f.FullName;
            $targetSession =$json;
            break;
        }
    } catch {
        continue;
    }
}

if (-not $targetFile) {
    Write-Error "Khong tim thay session cho Repo: $Repo, Issue: $Issue trong$sessionsDir";
    return;
}

Write-Host "Tim thay session file: $targetFile" -ForegroundColor Cyan;
Write-Host "Trang thai binding hien tai:" -ForegroundColor Yellow;
Write-Host "  - prNumber    : $($targetSession['prNumber'])";
Write-Host "  - headSha     : $($targetSession['headSha'])";
Write-Host "  - worktreePath: $($targetSession['worktreePath'])";

$updated =$false;
if ($PSBoundParameters.ContainsKey('PrNumber')) {
    $targetSession['prNumber'] =$PrNumber;
    $updated =$true;
}
if ($PSBoundParameters.ContainsKey('HeadSha')) {
    $targetSession['headSha'] =$HeadSha;
    $updated =$true;
}
if ($PSBoundParameters.ContainsKey('WorktreePath')) {
    $targetSession['worktreePath'] =$WorktreePath;
    $updated =$true;
}

if (-not $updated) {
    Write-Host "Khong co tham so cap nhat nao duoc cung cap. Giu nguyen hien trang." -ForegroundColor Gray;
    return;
}

$targetSession['updatedAt'] = [System.DateTime]::UtcNow.ToString('o');

Write-Host "`nTrang thai binding moi:" -ForegroundColor Green;
Write-Host "  - prNumber    : $($targetSession['prNumber'])";
Write-Host "  - headSha     : $($targetSession['headSha'])";
Write-Host "  - worktreePath: $($targetSession['worktreePath'])";
Write-Host "  - updatedAt   : $($targetSession['updatedAt'])";

if ($DryRun) {
    Write-Host "`n[DRY-RUN] Khong ghi file len dia." -ForegroundColor Magenta;
    return;
}

$bakFile =$targetFile + '.bak';
[System.IO.File]::Copy($targetFile, $bakFile,$true);
Write-Host "`nDa sao luu file goc: $bakFile" -ForegroundColor Gray;

$newJsonText = ConvertTo-Json -InputObject $targetSession -Depth 10;
[System.IO.File]::WriteAllText($targetFile, $newJsonText, $utf8NoBom);
Write-Host "[HOAN TAT] Da cap nhat binding thanh cong!" -ForegroundColor Green;