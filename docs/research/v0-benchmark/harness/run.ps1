param(
  [Parameter(Mandatory = $true)][string]$Task,
  [Parameter(Mandatory = $true)][ValidateSet("A", "B", "C")][string]$Arm,
  [Parameter(Mandatory = $true)][int]$Rep
)

$ErrorActionPreference = "Stop"
$root = "E:\githup\2026\my-workflow-ai\test-porject"
$tmplMap = @{ A = "template-plain"; B = "template-akrs"; C = "template-akrs-haiku" }
$tmpl = Join-Path $root $tmplMap[$Arm]
$runsRoot = "E:\akrs-runs"
$runDir = Join-Path $runsRoot "$Arm\$Task\rep$Rep"

$tasks = (Get-Content (Join-Path $root "harness\tasks.json") -Raw | ConvertFrom-Json).tasks
$t = $tasks.$Task

# --- build the prompt ---
if ($Arm -eq "A") {
  $prompt = @"
You are working in a TypeScript physics sandbox project (built with Vite). Complete the task below by editing the code.

TASK:
$($t.desc)

ACCEPTANCE:
$($t.accept)

Make the changes now. When finished, the project must pass ``npm run typecheck``.
"@
}
else {
  $prompt = @"
You are a worker agent in this repository. First read /AGENTS.md and follow the routing system it describes. Complete the task defined in the task file ``plans/physics-core/tasks/task-$Task.md`` by editing the code. When finished, the project must pass ``npm run typecheck``.
"@
}

# --- fresh run dir: copy template (with .git, without node_modules) + junction ---
if (Test-Path $runDir) { Remove-Item $runDir -Recurse -Force }
New-Item -ItemType Directory -Force $runDir | Out-Null
robocopy $tmpl $runDir /E /XD node_modules /NFL /NDL /NJH /NJS /NC /NS | Out-Null
New-Item -ItemType Junction -Path (Join-Path $runDir "node_modules") -Target (Join-Path $root "template-plain\node_modules") | Out-Null

Set-Content -Path (Join-Path $runDir "_prompt.txt") -Value $prompt -Encoding utf8

# --- run Haiku headless ---
$log = Join-Path $runDir "_run.jsonl"
$err = Join-Path $runDir "_run.err"
Push-Location $runDir
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$out = $prompt | claude -p --model claude-haiku-4-5 --output-format stream-json --verbose --dangerously-skip-permissions 2> $err
$sw.Stop()
Pop-Location
[IO.File]::WriteAllLines($log, @($out), (New-Object System.Text.UTF8Encoding($false)))

# --- capture the change set (working tree vs committed baseline) ---
git -C $runDir --no-pager status --porcelain | Out-File (Join-Path $runDir "_changed.txt") -Encoding utf8
Set-Content -Path (Join-Path $runDir "_meta.json") -Value (@{ task = $Task; arm = $Arm; rep = $Rep; ms = $sw.ElapsedMilliseconds } | ConvertTo-Json) -Encoding utf8

Write-Output "DONE $Arm/$Task/rep$Rep  ($($sw.ElapsedMilliseconds)ms)"
