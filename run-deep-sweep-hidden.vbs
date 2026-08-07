' Daily Task Scheduler entry point ("Personal CRM Deep Sweep").
' Window style 0 = hidden; Task Scheduler would otherwise flash a terminal.
'
' Runs the archive sweep in --deep mode: ignore the per-source cursors and
' re-walk ALL of Signal's history, so any message whose reused rowid slipped
' under the hourly incremental bound (a disappearing message deleted off the top
' of the table, then a new arrival handed the freed rowid) is still copied into
' crm.db. Free, no model. It costs more CPU than the hourly sweep because it
' re-examines every row, which is why it is daily rather than hourly.
'
' The hourly "Personal CRM Archive Sweep" task still runs and is what captures
' messages minute-to-minute; this is a once-a-day belt-and-suspenders pass.

Option Explicit
Dim sh, fso, f, node, root, logDir, logFile

Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

node = "C:\Program Files\nodejs\node.exe"
root = "C:\Users\natha\Programming\personal-crm"
logDir = root & "\logs"
logFile = logDir & "\deep-sweep.log"

If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir

' Cap the log rather than rotating: one run a day appends a few lines, and the
' most recent run is the only interesting one. Restart past ~1 MB.
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 1048576 Then fso.DeleteFile logFile
End If

Set f = fso.OpenTextFile(logFile, 8, True)
f.WriteLine "=== " & Now & " ==="
f.Close

' cmd /s /c with the whole command in one quoted string: /s makes cmd strip
' exactly the outermost quote pair and treat the remainder verbatim, the only
' reliable way to pass a quoted path plus a redirection through it.
sh.Run "cmd /s /c " & Q(Q(node) & " " & Q(root & "\scripts\crm-archive.js") _
  & " --deep >> " & Q(logFile) & " 2>&1"), 0, True

Function Q(s)
  Q = Chr(34) & s & Chr(34)
End Function
