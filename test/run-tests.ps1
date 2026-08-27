# dsh-rollout 全量测试运行器：遍历 test/*.mjs 逐个 node 跑，汇总失败。
# 用法：npm test   或   pwsh -File test/run-tests.ps1
$dir = $PSScriptRoot
$fail = 0
$total = 0
Get-ChildItem -LiteralPath $dir -Filter '*.mjs' | Sort-Object Name | ForEach-Object {
  $total++
  $out = & node $_.FullName 2>&1
  $last = ($out | Select-Object -Last 1)
  if ($LASTEXITCODE -eq 0) { Write-Host ("PASS  {0}  ->  {1}" -f $_.Name, $last) }
  else { Write-Host ("FAIL  {0}  ->  {1}" -f $_.Name, $last); $fail++ }
}
Write-Host ""
if ($fail -gt 0) { Write-Host ("{0}/{1} test(s) FAILED" -f $fail, $total); exit 1 }
Write-Host ("ALL {0} TESTS PASSED" -f $total); exit 0
