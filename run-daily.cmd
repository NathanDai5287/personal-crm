@echo off
setlocal
set PI_SKIP_VERSION_CHECK=1
cd /d "C:\Users\natha\Programming\personal-crm"
node scripts\crm-daily.js >> logs\daily.log 2>&1
endlocal
