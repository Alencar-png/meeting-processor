' ============================================================
' Meeting Processor - inicia o watcher em segundo plano (sem janela)
' Portável: usa a pasta do próprio script, sem caminhos fixos.
' Requer Python e ffmpeg no PATH do sistema.
' ============================================================
Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "pythonw -m meeting_processor watch", 0, False
