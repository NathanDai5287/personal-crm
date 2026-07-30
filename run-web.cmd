@echo off
REM Launch the local Personal CRM profile viewer at http://localhost:8787
REM Password: set CRM_WEB_PASSWORD, or let it generate one into data\web-password.txt
cd /d "%~dp0"
node scripts\crm-web.js
