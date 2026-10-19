param(
  # 写入 topics 的仓库，格式为 `owner/name`。这里刻意没有默认值，也没有硬编码的
  # owner：仓库归属是某次部署的事实，受版本控制的脚本若把它写死，会让其他克隆静默指向
  # 别人的仓库。请显式传入——`git remote get-url origin` 会给出它。
  [Parameter(Mandatory = $true)]
  [string]$Repo
)

if ($Repo -notmatch '^[^/\s]+/[^/\s]+$') {
  Write-Host "expected -Repo as 'owner/name', got: $Repo"
  exit 1
}

Set-Location (Join-Path $PSScriptRoot "..")
Write-Host "=== GitHub CLI login (browser flow) ==="
Write-Host "按提示操作：记下一次性代码 -> 回车打开浏览器 -> 粘贴代码授权"
Write-Host ""
gh auth login --hostname github.com --git-protocol ssh --web
if ($LASTEXITCODE -ne 0) { Write-Host "login failed - close and retry"; exit 1 }
Write-Host ""
Write-Host "=== setting repository topics on $Repo ==="
gh api --method PUT "repos/$Repo/topics" `
  -f "names[]=dsh-plugin" `
  -f "names[]=deepseek-harness" `
  -f "names[]=dsh" `
  -f "names[]=deepseek"
Write-Host ""
Write-Host "=== done ==="
Write-Host "topics 已设置。这个窗口可以关了。"
