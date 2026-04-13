@echo off
setlocal

REM 把这里改成你的项目目录
set "WORKDIR=F:\Data\work document\codex\vending machine"

if not exist "%WORKDIR%" (
    echo 工作目录不存在: %WORKDIR%
    pause
    exit /b 1
)

REM 启动 api
start "dev-api-once" cmd /k "cd /d %WORKDIR% && npm run dev:api:once"

REM 启动 admin
start "dev-admin" cmd /k "cd /d %WORKDIR% && npm run dev:admin"

endlocal