@echo off
rem file-tool 本地控制台：双击启动，自动打开浏览器页面
cd /d %~dp0
npm run console %*
