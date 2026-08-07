<#
Registers the "Personal CRM Archive Sweep" Windows Scheduled Task: runs
scripts/crm-archive.js (via the hidden VBS launcher) once an hour, so messages
with short disappearing-message timers get captured into crm.db's archive
long before the nightly AI pipeline runs.

    powershell -ExecutionPolicy Bypass -File tools\register-archive-task.ps1
#>

$ErrorActionPreference = 'Stop'

$TaskName = 'Personal CRM Archive Sweep'
$RootDir = 'C:\Users\natha\Programming\personal-crm'
$Launcher = Join-Path $RootDir 'run-archive-hidden.vbs'

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Launcher`"" -WorkingDirectory $RootDir
# Top of every hour, indefinitely. Anchoring -At to midnight (rather than "now")
# lands every run on the hour (:00) instead of at whatever minute this happened to
# be registered. Note the 03:00 tick overlaps the daily deep sweep (also 03:00) and
# the 04:00 Monday tick overlaps the weekly AI run; there is no shared pipeline lock
# yet, but busy_timeout makes those overlaps survivable.
$trigger = New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Hourly Signal->crm.db archive sweep (scripts/crm-archive.js). No AI; captures disappearing messages.' `
    -Force

Write-Host "Registered scheduled task '$TaskName' (top of every hour, hidden)"
