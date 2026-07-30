<#
Registers the "Personal CRM Daily" Windows Scheduled Task.

FILE ONLY — this script is NOT run automatically as part of the migration.
Review it, then run it yourself (in an elevated or normal PowerShell session,
depending on your Task Scheduler permissions) when you're ready to enable the
daily job:

    powershell -ExecutionPolicy Bypass -File tools\register-task.ps1

It creates/updates a task that runs run-daily.cmd once a day at 04:00, with
StartWhenAvailable so a missed run (e.g. machine asleep at 04:00) catches up
the next time the machine is available.
#>

$ErrorActionPreference = 'Stop'

$TaskName = 'Personal CRM Daily'
$RootDir = 'C:\Users\natha\Programming\personal-crm'
$Cmd = Join-Path $RootDir 'run-daily.cmd'

$action = New-ScheduledTaskAction -Execute $Cmd -WorkingDirectory $RootDir
$trigger = New-ScheduledTaskTrigger -Daily -At '04:00'
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Runs the personal-crm daily pipeline (scripts/crm-daily.js) once a day, catching up on missed runs.' `
    -Force

Write-Host "Registered scheduled task '$TaskName' -> $Cmd (daily @ 04:00, StartWhenAvailable)"
