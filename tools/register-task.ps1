<#
Registers the "Personal CRM Weekly" Windows Scheduled Task.

FILE ONLY — this script is NOT run automatically. Review it, then run it
yourself when you're ready to enable the unattended AI pipeline:

    powershell -ExecutionPolicy Bypass -File tools\register-task.ps1

CADENCE: Monday 04:00 local (Pacific). This is deliberately the same instant as
the week boundary used by lib/weeks.js, so each run picks up exactly the week
that just closed and every merge sees a WHOLE week of messages rather than a
fragment of one. Changing the day or hour here without changing ANCHOR_HOUR /
the Monday anchor in lib/weeks.js would break that alignment: the run would fire
mid-week and the last partial week would sit unmerged until the following week.

This task runs the AI pipeline (ingest: merges + Timeline). It is NOT what captures
messages — that is the separate hourly "Personal CRM Archive Sweep" task (see
tools/register-archive-task.ps1), which must stay registered. The hourly sweep
is what protects disappearing messages; this weekly task only reads the archive.

StartWhenAvailable means a missed run (machine asleep at 04:00 Monday) catches
up when the machine next wakes, rather than being skipped until the next week.
ExecutionTimeLimit is 6 hours because a first full-history backfill walks many
chunks sequentially; an ordinary weekly run takes minutes.
#>

$ErrorActionPreference = 'Stop'

$TaskName = 'Personal CRM Weekly'
$OldTaskName = 'Personal CRM Daily'   # superseded by the weekly cadence
$RootDir = 'C:\Users\natha\Programming\personal-crm'
$Cmd = Join-Path $RootDir 'run-daily.cmd'

# Remove the old daily task if a previous version of this script registered it,
# so the two can't both fire.
try {
    if (Get-ScheduledTask -TaskName $OldTaskName -ErrorAction Stop) {
        Unregister-ScheduledTask -TaskName $OldTaskName -Confirm:$false
        Write-Host "Removed superseded task '$OldTaskName'"
    }
} catch {
    # not registered — nothing to remove
}

$action = New-ScheduledTaskAction -Execute $Cmd -WorkingDirectory $RootDir
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '04:00'
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 6)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Runs the personal-crm AI pipeline (scripts/crm-daily.js): ingest = week-aligned merges + Timeline. Mondays 04:00 Pacific, matching the week boundary in lib/weeks.js. Message capture is the separate hourly archive sweep.' `
    -Force

Write-Host "Registered scheduled task '$TaskName' -> $Cmd (Mondays @ 04:00, StartWhenAvailable)"
Write-Host "Reminder: the hourly 'Personal CRM Archive Sweep' task must stay registered — it is what captures messages."
