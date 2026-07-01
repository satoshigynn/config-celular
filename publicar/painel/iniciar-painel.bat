@echo off
title Painel de Configuracao do Celular
echo Iniciando o painel local...
echo Abra no navegador: http://localhost:8787
echo (feche esta janela para encerrar)
echo.
rem usa o node.exe EMBUTIDO (..\node.exe); se nao existir, tenta o node do sistema
set "NODE=%~dp0..\node.exe"
if not exist "%NODE%" set "NODE=node"
start "" http://localhost:8787
"%NODE%" "%~dp0server.cjs"
pause
