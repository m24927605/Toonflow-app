!include LogicLib.nsh

; NSIS is x86; use the x64 checker to inspect the Runtime of the same architecture as the app.
Function ensureWebView2
  InitPluginsDir
  File "/oname=$PLUGINSDIR\checkWebView2.exe" "${webView2Dir}\checkWebView2.exe"
  File "/oname=$PLUGINSDIR\WebView2Loader.dll" "${webView2Dir}\WebView2Loader.dll"

  SetDetailsPrint textonly
  DetailPrint "正在检查 WebView2 运行时版本…"
  SetDetailsPrint none
  nsExec::ExecToStack /TIMEOUT=15000 '"$PLUGINSDIR\checkWebView2.exe"'
  Pop $0
  Pop $1
  ${If} $0 == 0
    SetDetailsPrint both
    Return
  ${EndIf}
  ${If} $0 != 1
  ${AndIf} $0 != 3
    MessageBox MB_OK|MB_ICONSTOP "无法检测 WebView2 运行时，请重新运行安装包。$\r$\n检测返回码：$0$\r$\n$1" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}

  File "/oname=$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" "${webView2Dir}\MicrosoftEdgeWebview2Setup.exe"
  ClearErrors
  ${If} ${Silent}
    ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install' $2
  ${ElseIf} $0 == 3
    SetDetailsPrint textonly
    DetailPrint "WebView2 版本过旧，请允许微软安装器获取管理员权限并完成更新…"
    SetDetailsPrint none
    ; ACT: Per-user mode may treat an existing old Runtime as
    ; installed; only the Microsoft updater process requests elevation.
    StrCpy $2 "管理员更新已结束，以版本检测为准"
    ExecShellWait "runas" "$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe"
  ${Else}
    SetDetailsPrint textonly
    DetailPrint "WebView2 缺失或版本过旧，请在弹出的微软窗口中完成安装或更新…"
    SetDetailsPrint none
    ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe"' $2
  ${EndIf}
  ${If} ${Errors}
    StrCpy $2 "无法启动或已取消管理员授权"
  ${EndIf}

  ; The installer exit code does not prove the Runtime was updated; recheck the actual version in a new process.
  SetDetailsPrint textonly
  DetailPrint "正在验证 WebView2 运行时…"
  SetDetailsPrint none
  nsExec::ExecToStack /TIMEOUT=15000 '"$PLUGINSDIR\checkWebView2.exe"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_YESNO|MB_ICONSTOP "WebView2 运行时仍缺失或版本过旧，应用安装已停止。$\r$\n若微软安装仍在进行，请等待完成后重试。若提示已安装，请以管理员身份运行最新版微软安装器；仍失败时，请修复 WebView2 或联系管理员检查更新服务和策略。$\r$\n是否打开微软官方下载页？$\r$\n安装结果：$2；检测返回码：$0$\r$\n$1" /SD IDNO IDNO +2
    ExecShell "open" "https://developer.microsoft.com/microsoft-edge/webview2/#download"
    SetErrorLevel 2
    Abort
  ${EndIf}
  SetDetailsPrint both
FunctionEnd
