' Hourly Task Scheduler entry point ("Personal CRM Archive Sweep").
' Window style 0 = hidden; Task Scheduler would otherwise flash a terminal every hour.
'
' WHY BOTH STEPS LIVE IN ONE SCRIPT, IN THIS ORDER. crm-todo-scan.js reads crm.db --
' the archive -- and never Signal, so it can only notice a "make sure" message that the
' sweep has already copied across. As two independent scheduled tasks they would race,
' and the scan would routinely read an archive an hour out of date. So the sweep is
' waited on (bWaitOnReturn = True) before the scan starts.
' Nathan: "lets just add it to the hourly archive task so they are at the same cadence."

Option Explicit
Dim sh, fso, f, node, root, logDir, logFile

Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

node = "C:\Program Files\nodejs\node.exe"
root = "C:\Users\natha\Programming\personal-crm"
logDir = root & "\logs"
logFile = logDir & "\todo-scan.log"

If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir

' Keep the log from growing without bound: 24 runs a day append a few lines each even
' when there is nothing to do. Restart the file past ~1 MB rather than rotating -- the
' interesting content is always the most recent run.
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 1048576 Then fso.DeleteFile logFile
End If

' --- 1. Archive sweep. Free, no model, seconds of work. -------------------------------
' Not logged: it is idempotent and its own state file records progress. Waited on so
' that step 2 sees every row it just mirrored.
sh.Run Q(node) & " " & Q(root & "\scripts\crm-archive.js"), 0, True

' --- 2. The "make sure" todo scan. ----------------------------------------------------
' A model is invoked ONLY when the regex fires, which on Nathan's real history is about
' 0.2 times a month -- so this is free on virtually every run, and costs a fraction of a
' cent when it is not. Tasks land as DRAFTS for manual acceptance:
' "i still want the draft queue. i should manually accept each one."
'
' CRM_ALLOW_PAID is set on THIS process only. The child inherits it at spawn and the
' variable dies with this script, so nothing else on the machine gains permission to
' spend -- the guard in crm-todo-scan.js stays armed everywhere except here.
'
' Output is appended to logs\todo-scan.log because window style 0 discards stdout, and
' the scan's near-miss lines ("said 'make sure' but not tracked") are the ONLY warning
' that a task Nathan meant to capture was phrased in a way the regex rejected. Throwing
' those away silently would defeat the reason they are reported at all.
Set f = fso.OpenTextFile(logFile, 8, True)
f.WriteLine "=== " & Now & " ==="
f.Close

sh.Environment("PROCESS")("CRM_ALLOW_PAID") = "1"

' cmd /s /c with the whole command in one quoted string: /s makes cmd strip exactly the
' outermost quote pair and treat the remainder verbatim, which is the only reliable way
' to pass several quoted paths plus a redirection through it.
sh.Run "cmd /s /c " & Q(Q(node) & " " & Q(root & "\scripts\crm-todo-scan.js") _
  & " --write >> " & Q(logFile) & " 2>&1"), 0, True

Function Q(s)
  Q = Chr(34) & s & Chr(34)
End Function
