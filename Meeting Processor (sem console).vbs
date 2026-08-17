' ============================================================
' Meeting Processor - abre o aplicativo sem janela de console.
'
' Use este atalho no dia a dia; o .bat serve quando voce quer
' ver as mensagens (primeira instalacao ou diagnostico de erro).
' ============================================================
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

pasta = fso.GetParentFolderName(WScript.ScriptFullName)
desktopDir = fso.BuildPath(pasta, "desktop")

If Not fso.FolderExists(fso.BuildPath(desktopDir, "node_modules")) Then
    ' Sem dependencias instaladas, o console e necessario: manda para o .bat.
    shell.Run """" & fso.BuildPath(pasta, "Meeting Processor.bat") & """", 1, False
Else
    shell.CurrentDirectory = desktopDir
    shell.Run "cmd /c npm start", 0, False
End If
