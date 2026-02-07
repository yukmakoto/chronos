param(
    [Parameter(Mandatory=$true)]
    [string]$Version,
    [switch]$Draft
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot

$Tag = "v$Version"
Write-Host "[release] Chronos $Tag" -ForegroundColor Cyan

# ── 前置检查 ──

foreach ($cmd in @('zig', 'gh')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "[release] 错误：$cmd 未安装" -ForegroundColor Red; exit 1
    }
}

foreach ($f in @('runtime/wrapper.node', 'runtime/qq/versions/config.json', 'config.example.json')) {
    if (-not (Test-Path $f)) {
        Write-Host "[release] 错误：缺少 $f" -ForegroundColor Red; exit 1
    }
}

$existingTag = git tag -l $Tag 2>$null
if ($existingTag) {
    Write-Host "[release] 错误：tag $Tag 已存在" -ForegroundColor Red; exit 1
}

# ── 更新版本号 ──

Set-Content -Path 'src/version.zig' -Value "pub const current = `"$Version`";`n" -NoNewline -Encoding UTF8
Write-Host "[release] 版本号 → $Version"

# ── 构建 ──

taskkill /IM chronos.exe /F 2>$null | Out-Null

Write-Host '[release] 编译 ReleaseSafe...'
zig build -Doptimize=ReleaseSafe
if ($LASTEXITCODE -ne 0) {
    Write-Host '[release] 构建失败' -ForegroundColor Red; exit 1
}

# ── 打包 zip ──

$stagingDir = 'zig-out/release-staging/chronos'
if (Test-Path $stagingDir) { Remove-Item -Recurse -Force $stagingDir }
New-Item -ItemType Directory -Path $stagingDir | Out-Null
New-Item -ItemType Directory -Path "$stagingDir/runtime" | Out-Null

Copy-Item 'zig-out/bin/chronos.exe' "$stagingDir/"
Copy-Item 'config.example.json' "$stagingDir/config.json"
Copy-Item 'runtime/wrapper.node' "$stagingDir/runtime/"
Copy-Item -Recurse 'runtime/qq' "$stagingDir/runtime/qq"

$zipName = "chronos-$Tag-windows-x64.zip"
$zipPath = "zig-out/$zipName"
if (Test-Path $zipPath) { Remove-Item $zipPath }

Compress-Archive -Path "zig-out/release-staging/chronos" -DestinationPath $zipPath
$sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host "[release] $zipName → $sizeMB MB"

Remove-Item -Recurse -Force 'zig-out/release-staging'

# ── Git tag + push ──

git add 'src/version.zig'
git commit -m "release: $Tag"
git tag -a $Tag -m "Chronos $Tag"
git push origin HEAD
git push origin $Tag

# ── GitHub Release ──

$releaseArgs = @('release', 'create', $Tag, '--title', "Chronos $Tag", '--generate-notes', $zipPath)
if ($Draft) { $releaseArgs += '--draft' }

gh @releaseArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host '[release] Release 创建失败' -ForegroundColor Red; exit 1
}

Write-Host "[release] Chronos $Tag 已发布" -ForegroundColor Green
