<#
Registers the "Personal CRM Deep Sweep" Windows Scheduled Task: runs
scripts/crm-archive.js --deep (via the hidden VBS launcher) once a day.

FILE ONLY - this script is NOT run automatically. Review it, then run it
yourself when you're ready to enable the daily deep sweep:

    powershell -ExecutionPolicy Bypass -File tools\register-deep-sweep-task.ps1

WHAT IT DOES: the hourly "Personal CRM Archive Sweep" is incremental - it trusts
its per-source cursors and only re-checks a short overlap window. That is fast,
but a message whose reused rowid lands far below the cursor can slip past it. The
deep sweep ignores cursors and re-walks all of Signal's history, so anything the
incremental bound missed is caught. Free, no model; seconds-to-minutes of DB work
over the whole archive, which is why it runs once a day rather than hourly.

CADENCE: daily at 03:00 local, one hour before the weekly Monday 04:00 AI run
(tools/register-task.ps1), so on Mondays the archive is fully re-walked right
before ingest reads it. On other days it is a standalone freshness pass. Note that
03:00 is also a top-of-hour tick for the hourly "Archive Sweep", so the two overlap
once a day; there is no shared pipeline lock yet, but busy_timeout makes that
survivable (and the deep sweep is a superset of the hourly run anyway).

StartWhenAvailable means a missed run (machine asleep at 03:00) catches up when
the machine next wakes. This task does NOT replace the hourly sweep - that one
still captures messages minute-to-minute and must stay registered.
#>

$ErrorActionPreference = 'Stop'

$TaskName = 'Personal CRM Deep Sweep'
$RootDir = 'C:\Users\natha\Programming\personal-crm'
$Launcher = Join-Path $RootDir 'run-deep-sweep-hidden.vbs'

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Launcher`"" -WorkingDirectory $RootDir
$trigger = New-ScheduledTaskTrigger -Daily -At '03:00'
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Daily deep archive sweep (scripts/crm-archive.js --deep): re-walks all Signal history to catch reused row ids from disappearing messages. No AI. 03:00 local, an hour before the weekly Monday AI run. The hourly Archive Sweep still captures messages minute-to-minute.' `
    -Force

Write-Host "Registered scheduled task '$TaskName' -> $Launcher (daily @ 03:00, hidden)"
Write-Host "Reminder: the hourly 'Personal CRM Archive Sweep' task must stay registered - it is what captures messages minute-to-minute; this is a daily belt-and-suspenders pass."
