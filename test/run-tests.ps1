# @tag: reusable
# @工程: dsh-memory_rollout
# @主诉: 运行仓库内 *.test.mjs 并汇总结果，供本插件回归验收
# dsh-memory_rollout 全量测试运行器：只遍历 test/*.test.mjs，避免误跑 helper/临时脚本。
# 用法：npm test   或   pwsh -File test/run-tests.ps1
$dir = $PSScriptRoot
$fail = 0
$total = 0
Get-ChildItem -LiteralPath $dir -Filter '*.test.mjs' | Sort-Object Name | ForEach-Object {
  $total++
  $out = & node $_.FullName 2>&1
  $last = ($out | Select-Object -Last 1)
  if ($LASTEXITCODE -eq 0) { Write-Host ("PASS  {0}  ->  {1}" -f $_.Name, $last) }
  else {
    Write-Host ("FAIL  {0}  ->  {1}" -f $_.Name, $last)
    $out | ForEach-Object { Write-Host ("      {0}" -f $_) }
    $fail++
  }
}
Write-Host ""
if ($fail -gt 0) { Write-Host ("{0}/{1} test(s) FAILED" -f $fail, $total); exit 1 }
Write-Host ("ALL {0} TESTS PASSED" -f $total); exit 0
