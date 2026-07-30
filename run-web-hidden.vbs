' Launches the CRM web server with no console window. A copy of / shortcut to
' this file lives in the user's Startup folder so the dashboard survives
' reboots. If the server is already running, the new instance exits on
' EADDRINUSE — harmless.
CreateObject("Wscript.Shell").Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\natha\Programming\personal-crm\scripts\crm-web.js""", 0, False
