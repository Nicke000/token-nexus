' TOKEN NEXUS - windowless launcher.
'
' Same job as start.bat, but with no console window at all: the server runs
' hidden and the dashboard opens as its own app-style window. There is nothing
' to close by accident - closing the dashboard window stops the server.
'
' ASCII only on purpose: .vbs files are read using the system ANSI code page,
' so non-ASCII text here would be mangled - same reason start.bat is ASCII.
'
' Used by the desktop shortcut that install-shortcut.bat creates.

Option Explicit

Dim shell, fso, here, probe
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here

' Node.js 22.15+ is required to read the zstd session logs.
On Error Resume Next
Set probe = shell.Exec("cmd /c node -p process.versions.node")
If Err.Number <> 0 Or probe.ExitCode <> 0 Then
  MsgBox "Node.js was not found." & vbCrLf & vbCrLf & "Install Node.js 22.15 or newer from https://nodejs.org/ , make sure ""Add to PATH"" is checked, then double-click the icon again.", vbExclamation, "TOKEN NEXUS"
  WScript.Quit 1
End If
On Error GoTo 0

' 0 = hidden window, False = do not wait. The dashboard opens by itself.
shell.Run "node """ & here & "\server.mjs"" --app", 0, False
