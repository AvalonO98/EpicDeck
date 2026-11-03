@echo off
REM =============================================================================
REM EpicDeck 一键部署脚本 (在 Windows 本机运行)
REM
REM 用法:
REM   双击运行,或命令行执行 deploy_from_windows.bat <SteamDeck_IP>
REM
REM 功能:
REM   1. 打包项目(排除 node_modules 等)上传到 Steam Deck
REM   2. 在 Steam Deck 上执行 scripts/deploy.sh 完成安装 + 重载
REM
REM 前置:
REM   - Steam Deck 已开启 SSH (sshd)
REM   - Windows 已安装 OpenSSH 客户端 (Win10+ 自带 scp/ssh)
REM =============================================================================
setlocal enabledelayedexpansion

REM ---- 配置 ---------------------------------------------------------------
set "DECK_USER=deck"
set "DECK_IP=%~1"
if "%DECK_IP%"=="" (
    set /p DECK_IP="请输入 Steam Deck 的 IP 地址: "
)

REM ---- 本地路径 ------------------------------------------------------------
set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."

echo.
echo === EpicDeck 部署到 Steam Deck (%DECK_IP%) ===
echo.

REM ---- 1. 测试 SSH 连接 -----------------------------------------------------
echo [1/3] 测试 SSH 连接...
ssh -o ConnectTimeout=5 %DECK_USER%@%DECK_IP% "echo SSH 连接成功" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] 无法连接 Steam Deck,请检查:
    echo   - Steam Deck 已开启 SSH: sudo systemctl enable --now sshd
    echo   - IP 地址正确: 在 Steam Deck 上运行 ip addr 查看
    echo   - 同一局域网
    exit /b 1
)
echo       连接成功

REM ---- 2. 打包并上传项目 ----------------------------------------------------
echo [2/3] 打包并上传项目文件...
set "TARBALL=%TEMP%\epicdeck_deploy.tar.gz"

REM 在项目目录打包(排除不必要的文件)
pushd "%PROJECT_DIR%"
tar --exclude=node_modules --exclude=.git --exclude=HANDOFF.md --exclude=scripts/deploy_from_windows.bat -czf "%TARBALL%" .
popd

echo       上传中 (可能需要十几秒)...
scp "%TARBALL%" %DECK_USER%@%DECK_IP%:/tmp/epicdeck_deploy.tar.gz
if errorlevel 1 (
    echo [ERROR] 上传失败
    exit /b 1
)

REM ---- 3. 解压并执行部署 -----------------------------------------------------
echo [3/3] 在 Steam Deck 上解压并执行部署...
ssh %DECK_USER%@%DECK_IP% "rm -rf /tmp/epicdeck_src && mkdir -p /tmp/epicdeck_src && tar -xzf /tmp/epicdeck_deploy.tar.gz -C /tmp/epicdeck_src && cd /tmp/epicdeck_src && chmod +x scripts/deploy.sh && ./scripts/deploy.sh"

echo.
echo === 部署完成 ===
echo 回到 Steam 游戏模式,打开 Decky 菜单找到 EpicDeck
echo.

del "%TARBALL%" >nul 2>&1
endlocal
pause
