#Requires -Version 5.1
<#
.SYNOPSIS
    Invoke-SocTask.ps1 - hardened Soc_brain task bootstrapper (AGENTS.md R1 -> R10).

.DESCRIPTION
    Source is pure ASCII so the file parses identically under Windows PowerShell 5.1
    (ANSI script reader) and PowerShell 7+ (UTF-8 reader). All generated files are
    written as UTF-8 without BOM. Goal text (including non-ASCII) is handled at
    runtime as proper .NET strings.

    Deterministic chicken-and-egg PR resolution (fail-closed at every step):
      1) resolve repo root, fetch base ref, require a clean primary checkout
      2) git checkout -b <branch> <startPoint>
      3) git commit --allow-empty -m "chore: initialize task under AGENTS.md"
      4) git push -u origin <branch>
      5) gh pr list --head <branch> (resume) else gh pr create  -> REAL PR number
      6) gh pr edit <pr> --add-label status:in-progress   (R8; never approved/blocked)
      7) restore the primary checkout to its original ref
      8) git worktree add worktrees/<task-name> <branch>   (R1/R10 isolation)
      9) render SOC_TASK_CONTRACT.md + TASK_PROMPT.md with the REAL PR number and
         commit them on the task branch - no bracketed PR placeholder can survive.

    Branch/task naming:
      with -IssueNumber : fix/issue-<id>-<goal-slug>
      without           : task/<goal-slug>-<yyyyMMdd-HHmmss>

    -DryRun performs validation + naming + contract rendering ONLY: no git, no gh,
    no network. Plan is emitted as one UTF-8 JSON document on stdout.

.PARAMETER Goal
    Required. Product goal / task title.
.PARAMETER IssueNumber
    Optional. Numeric GitHub issue id; selects the fix/issue-<id>-<slug> form.
.PARAMETER Base
    Base ref, default 'origin/main'.
.PARAMETER Repo
    GitHub repo slug, default 'duongpdddic-droid/Soc_brain'.
.PARAMETER RepoRoot
    Primary checkout root. Default: git rev-parse --show-toplevel of the CWD
    (DryRun falls back to the CWD when git is unavailable).
.PARAMETER WorktreesRoot
    Root for isolated task worktrees. Default: <RepoRoot>/worktrees.
.PARAMETER Timestamp
    Optional yyyyMMdd-HHmmss stamp for deterministic branch names (tests/resume).
.PARAMETER PullRequestNumber
    Optional pre-existing PR number: skips gh pr list/create but still labels.
.PARAMETER Draft
    Create the PR as a draft. Default is a ready (non-draft) PR.
.PARAMETER DryRun
    Offline planning mode: validate, name, render, emit JSON, touch nothing.

.OUTPUTS
    DryRun: JSON plan on stdout, exit 0.
    Real run: human summary on stdout, exit 0; exit 2 on bad arguments,
    exit 1 on any failed step (fail-closed).

.EXAMPLE
    ./scripts/Invoke-SocTask.ps1 -Goal "Harden automated task bootstrapper"
.EXAMPLE
    ./scripts/Invoke-SocTask.ps1 -Goal "Fix flake" -IssueNumber 218 -DryRun
#>
[CmdletBinding()]
param(
    [Parameter()] [string] $Goal = '',
    [Parameter()] [string] $IssueNumber = '',
    [Parameter()] [string] $Base = 'origin/main',
    [Parameter()] [string] $Repo = 'duongpdddic-droid/Soc_brain',
    [Parameter()] [string] $RepoRoot = '',
    [Parameter()] [string] $WorktreesRoot = '',
    [Parameter()] [string] $Timestamp = '',
    [Parameter()] [string] $PullRequestNumber = '',
    [Parameter()] [switch] $Draft,
    [Parameter()] [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (Test-Path -LiteralPath 'variable:PSNativeCommandUseErrorActionPreference') {
    $PSNativeCommandUseErrorActionPreference = $false
}

function ConvertTo-GoalSlug {
    <# Deterministic ASCII slug: NFD strip diacritics, d-stroke map, lower,
       non-alnum -> '-', collapse, trim, cap length, 'task' fallback. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [AllowEmptyString()] [string] $Goal,
        [Parameter()] [int] $MaxLength = 48
    )
    $slug = $Goal.Trim()
    $slug = [regex]::Replace($slug, '[\u0110\u0111]', 'd')
    try {
        $slug = $slug.Normalize([System.Text.NormalizationForm]::FormD)
        $slug = [regex]::Replace($slug, '\p{Mn}', '')
        $slug = $slug.Normalize([System.Text.NormalizationForm]::FormC)
    } catch {
        # Unpaired surrogates / exotic code points: keep raw form, regex below sanitizes.
    }
    $slug = $slug.ToLowerInvariant()
    $slug = [regex]::Replace($slug, '[^a-z0-9]+', '-')
    $slug = [regex]::Replace($slug, '-{2,}', '-')
    $slug = $slug.Trim('-')
    if ($slug.Length -gt $MaxLength) {
        $slug = $slug.Substring(0, $MaxLength).TrimEnd('-')
    }
    if ($slug.Length -eq 0) { $slug = 'task' }
    return $slug
}

function Get-SocTaskBranchName {
    <# task/<slug>-<ts> without issue; fix/issue-<id>-<slug> with issue. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string] $Goal,
        [Parameter()] [string] $IssueNumber = '',
        [Parameter()] [string] $Timestamp = ''
    )
    $slug = ConvertTo-GoalSlug -Goal $Goal
    $issue = ''
    if (-not [System.String]::IsNullOrWhiteSpace($IssueNumber)) {
        $issue = $IssueNumber.Trim()
        if ($issue -notmatch '^[0-9]+$') {
            throw "INVALID_ISSUE_NUMBER: '$IssueNumber' must be numeric."
        }
        return "fix/issue-$issue-$slug"
    }
    $ts = $Timestamp
    if ([System.String]::IsNullOrWhiteSpace($ts)) {
        $ts = [DateTime]::Now.ToString('yyyyMMdd-HHmmss')
    } elseif ($ts -notmatch '^[0-9]{8}-[0-9]{6}$') {
        throw "INVALID_TIMESTAMP: '$Timestamp' must match yyyyMMdd-HHmmss."
    }
    return "task/$slug-$ts"
}

function New-SocTaskPlan {
    <# Pure validation + naming. No git, no gh, no filesystem writes. #>
    [CmdletBinding()]
    param(
        [Parameter()] [string] $Goal = '',
        [Parameter()] [string] $IssueNumber = '',
        [Parameter()] [string] $Base = 'origin/main',
        [Parameter()] [string] $Repo = 'duongpdddic-droid/Soc_brain',
        [Parameter()] [string] $Timestamp = '',
        [Parameter()] [string] $PullRequestNumber = '',
        [Parameter()] [bool] $Draft = $false
    )
    if ([System.String]::IsNullOrWhiteSpace($Goal)) {
        throw 'GOAL_REQUIRED: -Goal <string> is required.'
    }
    if ([System.String]::IsNullOrWhiteSpace($Base)) {
        throw 'BASE_REQUIRED: -Base must be a non-empty ref (default origin/main).'
    }
    if ([System.String]::IsNullOrWhiteSpace($Repo)) {
        throw 'REPO_REQUIRED: -Repo must be a non-empty owner/name slug.'
    }
    $issue = ''
    if (-not [System.String]::IsNullOrWhiteSpace($IssueNumber)) {
        $issue = $IssueNumber.Trim()
        if ($issue -notmatch '^[0-9]+$') {
            throw "INVALID_ISSUE_NUMBER: '$IssueNumber' must be numeric."
        }
    }
    $pr = ''
    if (-not [System.String]::IsNullOrWhiteSpace($PullRequestNumber)) {
        $pr = $PullRequestNumber.Trim()
        if ($pr -notmatch '^[0-9]+$') {
            throw "INVALID_PULL_REQUEST_NUMBER: '$PullRequestNumber' must be numeric."
        }
    }
    $ts = $Timestamp
    if ([System.String]::IsNullOrWhiteSpace($ts)) {
        $ts = [DateTime]::Now.ToString('yyyyMMdd-HHmmss')
    } elseif ($ts -notmatch '^[0-9]{8}-[0-9]{6}$') {
        throw "INVALID_TIMESTAMP: '$Timestamp' must match yyyyMMdd-HHmmss."
    }
    $branch = Get-SocTaskBranchName -Goal $Goal -IssueNumber $issue -Timestamp $ts
    $ghBase = $Base
    $startPoint = $Base
    $fetchTarget = $Base
    if ($Base -match '^origin/(.+)$') {
        $ghBase = $Matches[1]
        $startPoint = $Base
        $fetchTarget = $Matches[1]
    } else {
        $startPoint = "origin/$Base"
        $fetchTarget = $Base
    }
    $prDisplay = $pr
    if ($prDisplay -eq '') { $prDisplay = 'UNRESOLVED-DRY-RUN' }
    $plan = [ordered]@{
        goal              = $Goal.Trim()
        slug              = ConvertTo-GoalSlug -Goal $Goal
        issueNumber       = $issue
        branch            = $branch
        taskName          = $branch
        base              = $Base
        ghBase            = $ghBase
        startPoint        = $startPoint
        fetchTarget       = $fetchTarget
        repo              = $Repo
        timestamp         = $ts
        pullRequestNumber = $pr
        pullRequest       = $prDisplay
        draft             = [bool] $Draft
        dryRun            = $false
        repoRoot          = ''
        worktreesRoot     = ''
        worktree          = ''
        worktreeDisplay   = ''
        contractPath      = ''
        promptPath        = ''
        contract          = ''
        taskPrompt        = ''
    }
    return $plan
}

function Write-Utf8File {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $true)] [AllowEmptyString()] [string] $Content
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Write-Utf8Stdout {
    <# Byte-exact UTF-8 (no BOM, no host codepage) on both PS 5.1 and PS 7. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [AllowEmptyString()] [string] $Text
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $stream = [System.Console]::OpenStandardOutput()
    $writer = New-Object System.IO.StreamWriter($stream, $encoding)
    try {
        $writer.Write($Text)
        $writer.Flush()
    } finally {
        $writer.Dispose()
    }
}

function Invoke-NativeCommand {
    <# Native exec with explicit exit-code check (PS 5.1 has no native EAP bridge).
       Temporarily relaxes EAP so stderr text cannot terminate mid-pipeline. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string] $Executable,
        [Parameter()] [string[]] $Arguments = @()
    )
    if (-not (Get-Command -Name $Executable -CommandType Application -ErrorAction SilentlyContinue)) {
        throw "COMMAND_NOT_FOUND: $Executable"
    }
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $Executable @Arguments 2>&1 | ForEach-Object { $_.ToString() })
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousEap
    }
    $text = ($lines -join "`n")
    if ($exitCode -ne 0) {
        throw ("COMMAND_FAILED exit={0}: {1} {2}`n{3}" -f $exitCode, $Executable, ($Arguments -join ' '), $text)
    }
    return $text.Trim()
}

function New-SocTaskContractContent {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)] $Plan)
    $issueLine = 'none'
    if ($Plan.issueNumber -ne '') { $issueLine = $Plan.issueNumber }
    return @"
# Task Contract - $($Plan.goal)

Context & Boundaries:
- Repository: $($Plan.repo)
- Target Branch: $($Plan.branch)
- Base: $($Plan.base)
- PR Number: $($Plan.pullRequest)
- Issue Number: $issueLine
- Worktree: $($Plan.worktreeDisplay)
- Compliance: AGENTS.md R1 -> R10; North Star v2.1.0 (Invariant 11, 15; harness over model dependence); Fail-Closed.

## GitHub Label Lifecycle (R8)
- On start: gh pr edit $($Plan.pullRequest) --add-label "status:in-progress"
- On handoff: gh pr edit $($Plan.pullRequest) --add-label "status:review-requested" --remove-label "status:in-progress"
- NEVER self-apply status:approved or status:blocked.

## Objectives
1. $($Plan.goal)

## Implementation Checklist
- [ ] Implementation matches the goal with minimum scope (R4).
- [ ] git status --short clean (no untracked source files).
- [ ] Diff bundle exported to artifacts/diffs/pr-$($Plan.pullRequest)-diff.zip (R5).

## Verification Gates (exit 0)
- node --test tests/task-bootstrapper.test.mjs
- node --test tests/*.test.mjs
- git diff --check

## Delivery & Handoff (R2, R5, R8)
- git diff origin/main...HEAD > artifacts/diffs/pr-$($Plan.pullRequest)-changes.diff
- Compress-Archive -Path artifacts/diffs/pr-$($Plan.pullRequest)-changes.diff -DestinationPath artifacts/diffs/pr-$($Plan.pullRequest)-diff.zip -Force
- Declare READY_FOR_REVIEW only with real evidence; never self-approve or merge.
"@
}

function New-SocTaskTaskPromptContent {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)] $Plan)
    $issueLine = 'none (create/link if the goal maps to an issue)'
    if ($Plan.issueNumber -ne '') { $issueLine = $Plan.issueNumber }
    return @"
# TASK PROMPT - $($Plan.goal)

## 1. Context & Boundaries
- Repository: $($Plan.repo)
- Target Branch: $($Plan.branch)
- Base: $($Plan.base)
- PR Number: $($Plan.pullRequest)
- Issue Number: $issueLine
- Compliance: AGENTS.md (R1 -> R10) and North Star v2.1.0 (Invariant 11, 15; harness over model dependence).

## 2. Git Worktree Setup (R1 & R10)
Pre-provisioned isolated worktree: $($Plan.worktreeDisplay)
If it must be recreated:
  git worktree add -b $($Plan.branch) $($Plan.worktreeDisplay) $($Plan.startPoint)

## 3. GitHub Label Lifecycle (R8)
  gh pr edit $($Plan.pullRequest) --add-label "status:in-progress" --remove-label "status:queued,status:changes-requested"
NEVER self-apply status:approved or status:blocked.

## 4. Objectives & Detailed Requirements
1. $($Plan.goal)

## 5. Implementation Checklist
- [ ] Goal delivered with minimum scope (R4), no self-expanded refactor.
- [ ] Targeted + regression + exactly one full suite PASS (global test policy).
- [ ] git status --short shows a clean worktree.

## 6. Verification Gates (mandatory PASS 100%)
  node --test tests/task-bootstrapper.test.mjs
  node --test tests/*.test.mjs
  git diff --check

## 7. Delivery & Handoff Protocol (R2, R5 & R8)
1. Commit clean, push the working branch (no force-push).
2. PR OPEN, draft: false.
3. Export the diff bundle:
   New-Item -ItemType Directory -Force -Path artifacts/diffs
   git diff origin/main...HEAD > artifacts/diffs/pr-$($Plan.pullRequest)-changes.diff
   Compress-Archive -Path artifacts/diffs/pr-$($Plan.pullRequest)-changes.diff -DestinationPath artifacts/diffs/pr-$($Plan.pullRequest)-diff.zip -Force
4. gh pr edit $($Plan.pullRequest) --add-label "status:review-requested" --remove-label "status:in-progress"
5. Handoff report must print the reviewer clipboard/inspect commands verbatim.
"@
}

function Invoke-SocTaskMain {
    [CmdletBinding()]
    param(
        [Parameter()] [string] $Goal = '',
        [Parameter()] [string] $IssueNumber = '',
        [Parameter()] [string] $Base = 'origin/main',
        [Parameter()] [string] $Repo = 'duongpdddic-droid/Soc_brain',
        [Parameter()] [string] $RepoRoot = '',
        [Parameter()] [string] $WorktreesRoot = '',
        [Parameter()] [string] $Timestamp = '',
        [Parameter()] [string] $PullRequestNumber = '',
        [Parameter()] [bool] $Draft = $false,
        [Parameter()] [bool] $DryRun = $false
    )
    $plan = New-SocTaskPlan -Goal $Goal -IssueNumber $IssueNumber -Base $Base `
        -Repo $Repo -Timestamp $Timestamp -PullRequestNumber $PullRequestNumber -Draft $Draft

    # --- resolve roots (local only, no network) --------------------------------
    if ([System.String]::IsNullOrWhiteSpace($RepoRoot)) {
        if ($DryRun) {
            $RepoRoot = (Get-Location).Path
        } else {
            $RepoRoot = Invoke-NativeCommand -Executable 'git' -Arguments @(
                '-C', (Get-Location).Path, 'rev-parse', '--show-toplevel')
        }
    }
    $RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
    if ([System.String]::IsNullOrWhiteSpace($WorktreesRoot)) {
        $WorktreesRoot = Join-Path -Path $RepoRoot -ChildPath 'worktrees'
    }
    $worktree = Join-Path -Path $WorktreesRoot -ChildPath $plan.branch
    # Committed documents stay portable: always the repo-relative worktrees/<branch>
    # form; the absolute path is only echoed on stdout/DryRun (never committed).
    $worktreeDisplay = 'worktrees/' + $plan.branch
    $plan.repoRoot = $RepoRoot
    $plan.worktreesRoot = $WorktreesRoot
    $plan.worktree = $worktree
    $plan.worktreeDisplay = $worktreeDisplay
    $plan.contractPath = Join-Path -Path $worktree -ChildPath 'SOC_TASK_CONTRACT.md'
    $plan.promptPath = Join-Path -Path $worktree -ChildPath 'TASK_PROMPT.md'
    $plan.dryRun = [bool] $DryRun

    if ($DryRun) {
        $plan.contract = New-SocTaskContractContent -Plan $plan
        $plan.taskPrompt = New-SocTaskTaskPromptContent -Plan $plan
        Write-Utf8Stdout -Text (($plan | ConvertTo-Json -Depth 8) + "`n")
        return
    }

    # --- real run: fail-closed preconditions ------------------------------------
    if (-not (Test-Path -LiteralPath (Join-Path -Path $RepoRoot -ChildPath '.git'))) {
        throw "NOT_A_GIT_REPO: $RepoRoot"
    }
    if (Test-Path -LiteralPath $worktree) {
        throw "WORKTREE_EXISTS: $worktree"
    }
    Invoke-NativeCommand -Executable 'git' -Arguments @(
        '-C', $RepoRoot, 'fetch', 'origin', $plan.fetchTarget) | Out-Null
    $porcelain = Invoke-NativeCommand -Executable 'git' -Arguments @(
        '-C', $RepoRoot, 'status', '--porcelain')
    if ($porcelain -ne '') {
        throw "PRIMARY_DIRTY: stash/commit first, bootstrapper will not switch a dirty checkout: $RepoRoot"
    }
    $originalRef = Invoke-NativeCommand -Executable 'git' -Arguments @(
        '-C', $RepoRoot, 'rev-parse', '--abbrev-ref', 'HEAD')
    if ($originalRef -eq 'HEAD') {
        $originalRef = Invoke-NativeCommand -Executable 'git' -Arguments @(
            '-C', $RepoRoot, 'rev-parse', 'HEAD')
    }

    $pr = $plan.pullRequestNumber
    $prUrl = ''
    $leftBranch = $false
    try {
        Invoke-NativeCommand -Executable 'git' -Arguments @(
            '-C', $RepoRoot, 'checkout', '-b', $plan.branch, $plan.startPoint) | Out-Null
        $leftBranch = $true
        Invoke-NativeCommand -Executable 'git' -Arguments @(
            '-C', $RepoRoot, 'commit', '--allow-empty',
            '-m', 'chore: initialize task under AGENTS.md') | Out-Null
        Invoke-NativeCommand -Executable 'git' -Arguments @(
            '-C', $RepoRoot, 'push', '-u', 'origin', $plan.branch) | Out-Null

        if ($pr -eq '') {
            $listJson = Invoke-NativeCommand -Executable 'gh' -Arguments @(
                'pr', 'list', '--repo', $plan.repo, '--head', $plan.branch,
                '--state', 'open', '--json', 'number,url')
            $existing = @()
            try { $existing = @($listJson | ConvertFrom-Json) } catch { $existing = @() }
            if ($existing.Count -gt 0) {
                $pr = [string] $existing[0].number
                $prUrl = [string] $existing[0].url
            } else {
                $body = "Automated task bootstrapped by Invoke-SocTask.ps1 (AGENTS.md R1 -> R10).`n`nGoal: $($plan.goal)`nBranch: $($plan.branch)"
                if ($plan.issueNumber -ne '') { $body = $body + "`nCloses #$($plan.issueNumber)" }
                $createArgs = @(
                    'pr', 'create', '--repo', $plan.repo,
                    '--base', $plan.ghBase, '--head', $plan.branch,
                    '--title', $plan.goal, '--body', $body)
                if ($Draft) { $createArgs = $createArgs + @('--draft') }
                $createOut = Invoke-NativeCommand -Executable 'gh' -Arguments $createArgs
                if ($createOut -notmatch 'https://\S+/pull/(\d+)') {
                    throw "PR_CREATE_NO_NUMBER: $createOut"
                }
                $pr = $Matches[1]
                $prUrl = $Matches[0]
            }
        }
        if ($pr -eq '') { throw 'PR_UNRESOLVED: refusing to scaffold without a real PR number.' }
        if ($prUrl -eq '') { $prUrl = "https://github.com/$($plan.repo)/pull/$pr" }
        Invoke-NativeCommand -Executable 'gh' -Arguments @(
            'pr', 'edit', $pr, '--repo', $plan.repo,
            '--add-label', 'status:in-progress') | Out-Null
    } finally {
        if ($leftBranch) {
            try {
                Invoke-NativeCommand -Executable 'git' -Arguments @(
                    '-C', $RepoRoot, 'checkout', $originalRef) | Out-Null
            } catch {
                Write-Warning "RESTORE_REF_FAILED (continuing): $($_.Exception.Message)"
            }
        }
    }

    # --- isolated worktree + contracts with the REAL PR number -------------------
    Invoke-NativeCommand -Executable 'git' -Arguments @(
        '-C', $RepoRoot, 'worktree', 'add', $worktree, $plan.branch) | Out-Null
    if (-not (Test-Path -LiteralPath $worktree)) {
        throw "WORKTREE_MISSING: git worktree add did not produce $worktree"
    }
    $plan.pullRequestNumber = $pr
    $plan.pullRequest = $pr
    $plan.contract = New-SocTaskContractContent -Plan $plan
    $plan.taskPrompt = New-SocTaskTaskPromptContent -Plan $plan
    if ($plan.contract -match '\[S._PR\]' -or $plan.taskPrompt -match '\[S._PR\]') {
        throw 'CONTRACT_PLACEHOLDER_LEAK: bracketed PR placeholder found after render.'
    }
    Write-Utf8File -Path $plan.contractPath -Content $plan.contract
    Write-Utf8File -Path $plan.promptPath -Content $plan.taskPrompt
    Invoke-NativeCommand -Executable 'git' -Arguments @(
        '-C', $worktree, 'add', 'SOC_TASK_CONTRACT.md', 'TASK_PROMPT.md') | Out-Null
    Invoke-NativeCommand -Executable 'git' -Arguments @(
        '-C', $worktree, 'commit', '-m', "chore(task): scaffold SOC contract for PR #$pr") | Out-Null
    Invoke-NativeCommand -Executable 'git' -Arguments @(
        '-C', $worktree, 'push', 'origin', $plan.branch) | Out-Null

    Write-Output ('=' * 60)
    Write-Output "BOOTSTRAP_OK goal=$($plan.goal)"
    Write-Output "branch=$($plan.branch)"
    Write-Output "pr=$pr url=$prUrl label=status:in-progress draft=$($plan.draft)"
    Write-Output "worktree=$worktree"
    Write-Output "contract=$($plan.contractPath)"
    Write-Output 'Next: cd into the worktree and execute the task prompt.'
    Write-Output ('=' * 60)
}

# --- entrypoint: skip when dot-sourced (unit-test harness) -----------------------
if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-SocTaskMain -Goal $Goal -IssueNumber $IssueNumber -Base $Base -Repo $Repo `
            -RepoRoot $RepoRoot -WorktreesRoot $WorktreesRoot -Timestamp $Timestamp `
            -PullRequestNumber $PullRequestNumber -Draft ([bool] $Draft) -DryRun ([bool] $DryRun)
        exit 0
    } catch {
        $message = ''
        if ($_.Exception -and $_.Exception.Message) { $message = $_.Exception.Message }
        else { $message = [string] $_ }
        [System.Console]::Error.WriteLine("BOOTSTRAP_FAILED: $message")
        if ($message -match '^(GOAL_REQUIRED|BASE_REQUIRED|REPO_REQUIRED|INVALID_)') { exit 2 }
        exit 1
    }
}
