param(
  [string[]]$Arms = @("A", "B"),
  [int]$Reps = 2,
  [string[]]$Tasks = @("T1", "T2", "T3", "T4", "T5")
)

$h = "E:\githup\2026\my-workflow-ai\test-porject\harness"
$results = "E:\akrs-runs\results.jsonl"
New-Item -ItemType Directory -Force "E:\akrs-runs" | Out-Null
Remove-Item $results -ErrorAction SilentlyContinue

$total = $Arms.Count * $Tasks.Count * $Reps
$i = 0
foreach ($arm in $Arms) {
  foreach ($task in $Tasks) {
    for ($r = 1; $r -le $Reps; $r++) {
      $i++
      Write-Output "[$i/$total] running $arm/$task/rep$r ..."
      try {
        & "$h\run.ps1" -Task $task -Arm $arm -Rep $r | Out-Null
        $m = node "$h\score.mjs" $task "E:\akrs-runs\$arm\$task\rep$r"
        Add-Content $results $m
        Write-Output "    $m"
      }
      catch {
        Write-Output "    ERROR $arm/$task/rep$r : $_"
        Add-Content $results (@{ task = $task; arm = $arm; rep = $r; error = "$_" } | ConvertTo-Json -Compress)
      }
    }
  }
}
Write-Output "ALL DONE ($i runs)"
