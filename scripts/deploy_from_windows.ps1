# =============================================================================
# EpicDeck 一键部署脚本 (在 Windows 本机运行, PowerShell 版)
#
# 用法:
#   .\deploy_from_windows.ps1 -DeckIp "192.168.1.100"
#
# 前置:
#   - Steam Deck 已开启 SSH
#   - Windows 已安装 OpenSSH 客户端 (scp/ssh)
# =============================================================================
param(
    [Parameter(Mandatory=$false)]
    [string]$DeckIp = "",
    [string]$DeckUser = "deck"
)

if ([string]::IsNullOrWhiteSpace($DeckIp)) {
    $DeckIp = Read-Host "请输入 Steam Deck 的 IP 地址"
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

Write-Host ""
Write-Host "=== EpicDeck 部署到 Steam Deck ($DeckIp) ===" -ForegroundColor Green
Write-Host ""

# 1. 测试 SSH
Write-Host "[1/3] 测试 SSH 连接..."
$sshTest = ssh -o ConnectTimeout=5 "$DeckUser@$DeckIp" "echo OK" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] 无法连接 Steam Deck" -ForegroundColor Red
    Write-Host "  检查: SSH 已开启、IP 正确、同一局域网"
    exit 1
}
Write-Host "      连接成功"

# 2. 打包上传
Write-Host "[2/3] 打包并上传项目..."
$Tarball = Join-Path $env:TEMP "epicdeck_deploy.tar.gz"

Push-Location $ProjectDir
tar --exclude=node_modules --exclude=.git --exclude=HANDOFF.md --exclude=scripts/deploy_from_windows.ps1 --exclude=scripts/deploy_from_windows.bat -czf $Tarball .
Pop-Location

scp $Tarball "$DeckUser@$DeckIp`:/tmp/epicdeck_deploy.tar.gz"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] 上传失败" -ForegroundColor Red
    exit 1
}

# 3. 解压执行
Write-Host "[3/3] 在 Steam Deck 上部署..."
ssh "$DeckUser@$DeckIp" "rm -rf /tmp/epicdeck_src && mkdir -p /tmp/epicdeck_src && tar -xzf /tmp/epicdeck_deploy.tar.gz -C /tmp/epicdeck_src && find /tmp/epicdeck_src -name '*.sh' -exec sed -i 's/\r$//' {} + && cd /tmp/epicdeck_src && chmod +x scripts/deploy.sh && ./scripts/deploy.sh"

Write-Host ""
Write-Host "=== 部署完成,回到游戏模式打开 Decky 菜单 ===" -ForegroundColor Green
Remove-Item $Tarball -ErrorAction SilentlyContinue
