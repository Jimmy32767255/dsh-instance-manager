# 把 dsh-instance-manager 以真实目录快照的形式部署到本机 dsh web profile
# （替换可能存在的开发用符号链接）。
#
# 这是单机开发时的便利脚本，不是仓库承诺的安装方式，README 不指向它。包本身不依赖
# 它，其中的 profile 目录结构属于运行中的宿主，不属于本插件。
#
# 采用快照而不是符号链接：链接式挂载会让每次工作区编辑都成为线上 bundle 变更——
# cordis-plugin-hmr 会在每次保存时重载运行中的实例，多文件重构的中间状态可能让整个
# 实例退出。快照把“正在编辑”与“正在运行”分开：随时编辑，有意部署，然后重启实例。
#
# 用法：
#   powershell -File scripts\deploy-profile.ps1              # 使用默认 home
#   powershell -File scripts\deploy-profile.ps1 -DshHome X   # 指定 home
#
# 部署后重启 dsh 实例，让它们加载这份快照。

param([string]$DshHome = "$env:USERPROFILE\.dsh")

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$dst = Join-Path $DshHome 'profiles\web\node_modules\dsh-instance-manager'

if (-not (Test-Path (Join-Path $repoRoot 'lib\index.js'))) {
  throw "run this script from the dsh-instance-manager checkout (missing lib\index.js under $repoRoot)"
}

# 链接检测必须使用 ReparsePoint 属性：对目录符号链接调用 Get-Item 可能解析到目标，
# 而 PS5.1 的 `Remove-Item -Recurse` 会跟随目录链接（会通过链接删除工作区）。使用
# `cmd /c rmdir` 只删除重解析点。
# 删除操作可能与运行中实例的文件监视器竞争：已删除但仍被引用的目录会进入 Windows 的
# “delete pending”状态，重建时返回拒绝访问。因此重试到名字真正消失。
for ($attempt = 0; $attempt -lt 12; $attempt++) {
  if (-not (Test-Path $dst)) { break }
  $dstItem = Get-Item $dst -Force -ErrorAction SilentlyContinue
  if ($dstItem -and ($dstItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Write-Host "removing dev link at $dst"
    cmd /c rmdir "$dst" | Out-Null
    if (Test-Path $dst) { throw "link removal failed — refusing to continue near the working tree" }
  } else {
    Write-Host "removing previous snapshot at $dst"
    Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
}
if (Test-Path $dst) { throw "could not clear $dst — a running instance's watcher still holds it; stop instances first, then re-run" }

New-Item -ItemType Directory -Force $dst | Out-Null
foreach ($name in 'lib', 'cordis.patch.yml', 'package.json', 'README.md', 'README.en.md') {
  Copy-Item (Join-Path $repoRoot $name) $dst -Recurse -Force
}

# 显式按 UTF-8 读取：package.json 含中文描述，而 Get-Content 默认使用系统 ANSI 代码页
# （zh-CN 上是 GBK），会破坏 UTF-8 并让 ConvertFrom-Json 抛出。
$version = (Get-Content (Join-Path $dst 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
Write-Host "deployed v$version -> $dst"
Write-Host 'next: restart your dsh instances (panel「停止当前」then relaunch),'
Write-Host 'and remember the working tree no longer feeds running instances.'
