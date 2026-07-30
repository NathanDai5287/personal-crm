' Launches the hourly archive sweep with no console window (Task Scheduler
' would otherwise flash a terminal every hour). See scripts/crm-archive.js.
CreateObject("Wscript.Shell").Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\natha\Programming\personal-crm\scripts\crm-archive.js""", 0, False
