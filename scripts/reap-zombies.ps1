# scripts/reap-zombies.ps1 - Safe Process Watchdog
param([int]$MaxRunningMinutes = 45)

Write-Host "=== SOC_BRAIN SAFE PROCESS WATCHDOG ===" -ForegroundColor Cyan
$now = Get-Date

# 1. Quet Node.js zombie chay qua lau
$nodeZombies = @(Get-Process node -ErrorAction SilentlyContinue | Where-Object { ($now - $_.StartTime).TotalMinutes -gt $MaxRunningMinutes })
if ($nodeZombies.Count -gt 0) {
    Write-Host "[NODE] Phat hien $($nodeZombies.Count) tien trinh Node zombie:" -ForegroundColor Yellow
    foreach ($p in $nodeZombies) {
        try {
            Stop-Process -Id $p.Id -Force -ErrorAction Stop
            Write-Host "  -> Da tram Node PID=$($p.Id)" -ForegroundColor Green
        } catch {
            Write-Host "  -> Khong the tram Node PID=$($p.Id): $_" -ForegroundColor Red
        }
    }
}

# 2. Quet Chrome CDP tu dong (Bao ve Chrome ca nhan cua Bo)
$chromeZombies = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $cmd = $_.CommandLine
    if (-not $cmd) { return $false }
    $isSoc = ($cmd -like "*--remote-debugging-port*") -or ($cmd -like "*soc-brain-cdp-profile*")
    if ($isSoc) {
        $runtime = ($now - $_.CreationDate).TotalMinutes
        return $runtime -gt $MaxRunningMinutes
    }
    return $false
})
if ($chromeZombies.Count -gt 0) {
    Write-Host "[CHROME CDP] Phat hien $($chromeZombies.Count) Chrome CDP zombie:" -ForegroundColor Yellow
    foreach ($c in $chromeZombies) {
        try {
            Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop
            Write-Host "  -> Da tram Chrome CDP PID=$($c.ProcessId)" -ForegroundColor Green
        } catch {
            Write-Host "  -> Khong the tram Chrome PID=$($c.ProcessId): $_" -ForegroundColor Red
        }
    }
}

if ($nodeZombies.Count -eq 0 -and $chromeZombies.Count -eq 0) {
    Write-Host "[OK] He thong sach se, Chrome ca nhan cua Bo an toan tuyet doi!" -ForegroundColor Green
}
