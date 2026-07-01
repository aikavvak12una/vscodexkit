#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const crypto = require("crypto");

const VERSION = "0.8.15";
const EXTENSION_DIR_PREFIX = "openai.chatgpt-";
const EXTENSION_JS = path.join("out", "extension.js");
const WEBVIEW_INDEX = path.join("webview", "index.html");
const WEBVIEW_UI = path.join("webview", "assets", "codexpatch-ui.js");
const WEBVIEW_ASSETS_DIR = path.join("webview", "assets");
const BASELINE_DIR = ".codexpatch";
const BASELINE_ORIGINAL_DIR = path.join(BASELINE_DIR, "original");
const BASELINE_META = path.join(BASELINE_DIR, "baseline.json");

const MARKERS = {
  notifyV1: "codexpatch:v1:turn-completed-notify",
  notifyV2: "codexpatch:v2:turn-completed-notify",
  notifyV3: "codexpatch:v3:turn-completed-system-notify",
  notifyV4: "codexpatch:v4:turn-completed-windows-toast",
  notifyV5: "codexpatch:v5:turn-completed-windows-system-notify",
  notifyV6: "codexpatch:v6:turn-completed-windows-toast-first",
  notifyV7: "codexpatch:v7:turn-completed-windows-toast-history",
  notifyV8: "codexpatch:v8:conversation-end-windows-toast-history",
  notifyV9: "codexpatch:v9:conversation-end-all-known-states",
  notifyV10: "codexpatch:v10:diagnostic-live-states",
  mcpLifecycle: "codexpatch:v1:mcp-lifecycle-conversation-end",
  appServerRequest: "codexpatch:v1:app-server-request-approval",
  threadStreamState: "codexpatch:v1:thread-stream-state-conversation-end",
  userInterrupt: "codexpatch:v1:user-interrupt-suppress",
  webviewUserInterrupt: "codexpatch:v1:webview-user-interrupt",
  webviewAutoRetry: "codexpatch:v2:webview-auto-retry-send",
  webviewAutoRetryCommand: "codexpatch:v1:webview-auto-retry-command",
  hostSettingsV2: "codexpatch:v2:host-settings",
  hostSettings: "codexpatch:v3:host-settings",
  webviewIndex: "codexpatch:v2:webview-index",
  webviewUiV2: "codexpatch:v2:webview-ui",
  webviewUiV3: "codexpatch:v3:webview-ui",
  webviewUiV4: "codexpatch:v4:webview-ui",
  webviewUiV5: "codexpatch:v5:webview-ui",
  webviewUiV6: "codexpatch:v6:webview-ui",
  webviewUiV7: "codexpatch:v7:webview-ui",
  webviewUi: "codexpatch:v8:webview-ui-diagnostic-lite"
};

const ORIGINAL_NOTIFICATION_ANCHOR =
  'e.push(d.registerInternalNotificationHandler(Re=>{Re.method==="turn/completed"&&E.emit("turnComplete")}));';

const V1_NOTIFICATION_HANDLER =
  'e.push(d.registerInternalNotificationHandler(Re=>{/* codexpatch:v1:turn-completed-notify */if(Re.method==="turn/completed"){E.emit("turnComplete");try{let st=Re.params?.turn?.status,err=Re.params?.turn?.error,msg=err?.message||err?.detail||err?.code||"";if(st==="completed")ut.window.showInformationMessage("Codex 任务已完成");else ut.window.showWarningMessage("Codex 任务结束: "+(st??"unknown")+(msg?": "+String(msg).slice(0,180):""))}catch(_){}}}));';

const V2_NOTIFICATION_HANDLER =
  'e.push(d.registerInternalNotificationHandler(Re=>{/* codexpatch:v2:turn-completed-notify */if(Re.method==="turn/completed"){E.emit("turnComplete");try{let cfg=globalThis.__codexpatchSettings||{};if(cfg.notify!==false){let st=Re.params?.turn?.status,err=Re.params?.turn?.error,msg=err?.message||err?.detail||err?.code||"";if(st==="completed")ut.window.showInformationMessage("Codex 任务已完成");else ut.window.showWarningMessage("Codex 任务结束: "+(st??"unknown")+(msg?": "+String(msg).slice(0,180):""))}}catch(_){}}}));';

const V3_NOTIFICATION_HANDLER = `e.push(d.registerInternalNotificationHandler(Re=>{/* codexpatch:v3:turn-completed-system-notify */if(Re.method==="turn/completed"){E.emit("turnComplete");try{let cfg=globalThis.__codexpatchSettings||{};if(cfg.notify!==false){let st=Re.params?.turn?.status,err=Re.params?.turn?.error,msg=err?.message||err?.detail||err?.code||"",ok=st==="completed",title="Codex",body=ok?"Codex 任务已完成":"Codex 任务结束: "+(st??"unknown")+(msg?": "+String(msg).slice(0,180):""),sent=false;if(process.platform==="win32")try{let ps="$ErrorActionPreference='SilentlyContinue';Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;$icon=if($env:CODEXPATCH_ICON -eq 'Warning'){[System.Windows.Forms.ToolTipIcon]::Warning}else{[System.Windows.Forms.ToolTipIcon]::Info};$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.BalloonTipIcon=$icon;$n.BalloonTipTitle=$env:CODEXPATCH_TITLE;$n.BalloonTipText=$env:CODEXPATCH_BODY;$n.Visible=$true;$n.ShowBalloonTip(5000);Start-Sleep -Milliseconds 5500;$n.Dispose();",cp=require("child_process"),p=cp.spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-Command",ps],{windowsHide:true,detached:true,stdio:"ignore",env:{...process.env,CODEXPATCH_TITLE:title,CODEXPATCH_BODY:body,CODEXPATCH_ICON:ok?"Info":"Warning"}});p.unref?.(),sent=true}catch(_){}sent||(ok?ut.window.showInformationMessage(body):ut.window.showWarningMessage(body))}}catch(_){}}}));`;

const V4_NOTIFICATION_HANDLER = `e.push(d.registerInternalNotificationHandler(Re=>{/* codexpatch:v4:turn-completed-windows-toast */if(Re.method==="turn/completed"){E.emit("turnComplete");try{let cfg=globalThis.__codexpatchSettings||{};if(cfg.notify!==false){let st=Re.params?.turn?.status,err=Re.params?.turn?.error,msg=err?.message||err?.detail||err?.code||"",ok=st==="completed",title="Codex",body=ok?"Codex 任务已完成":"Codex 任务结束: "+(st??"unknown")+(msg?": "+String(msg).slice(0,180):"");if(process.platform==="win32")try{let ps="$ErrorActionPreference='SilentlyContinue';function Show-CodexToast{try{[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;$template=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);$texts=$template.GetElementsByTagName('text');[void]$texts.Item(0).AppendChild($template.CreateTextNode($env:CODEXPATCH_TITLE));[void]$texts.Item(1).AppendChild($template.CreateTextNode($env:CODEXPATCH_BODY));$toast=[Windows.UI.Notifications.ToastNotification]::new($template);$ids=@($env:CODEXPATCH_AUMID,'Microsoft.VisualStudioCode','Microsoft.VisualStudioCodeInsiders','VSCodium.VSCodium')|Where-Object{$_};foreach($id in $ids){try{[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show($toast);return $true}catch{}}}catch{}return $false};if(-not (Show-CodexToast)){Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;$icon=if($env:CODEXPATCH_ICON -eq 'Warning'){[System.Windows.Forms.ToolTipIcon]::Warning}else{[System.Windows.Forms.ToolTipIcon]::Info};$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.BalloonTipIcon=$icon;$n.BalloonTipTitle=$env:CODEXPATCH_TITLE;$n.BalloonTipText=$env:CODEXPATCH_BODY;$n.Visible=$true;$n.ShowBalloonTip(5000);Start-Sleep -Milliseconds 5500;$n.Dispose();}",cp=require("child_process"),p=cp.spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-Sta","-Command",ps],{windowsHide:true,detached:true,stdio:"ignore",env:{...process.env,CODEXPATCH_TITLE:title,CODEXPATCH_BODY:body,CODEXPATCH_ICON:ok?"Info":"Warning",CODEXPATCH_AUMID:"Microsoft.VisualStudioCode"}});p.unref?.()}catch(_){ok?ut.window.showInformationMessage(body):ut.window.showWarningMessage(body)}else ok?ut.window.showInformationMessage(body):ut.window.showWarningMessage(body)}}catch(_){}}}));`;

const WINDOWS_SYSTEM_NOTIFY_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$script:shown = $false
function Add-CodexShortcutTypes {
  if ('CodexPatchToast.Shortcut' -as [type]) { return $true }
  $source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexPatchToast {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  public class CShellLink {}

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  public interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cchMaxPath, IntPtr pfd, uint fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cchMaxName);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cchMaxPath);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cchMaxPath);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cchIconPath, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hwnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
  public interface IPersistFile {
    void GetClassID(out Guid pClassID);
    void IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, bool fRemember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  public interface IPropertyStore {
    void GetCount(out uint cProps);
    void GetAt(uint iProp, out PROPERTYKEY pkey);
    void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    void Commit();
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PROPERTYKEY {
    public Guid fmtid;
    public uint pid;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROPVARIANT {
    public ushort vt;
    public ushort wReserved1;
    public ushort wReserved2;
    public ushort wReserved3;
    public IntPtr p;
    public int p2;
  }

  public static class Shortcut {
    public static void Create(string shortcutPath, string targetPath, string arguments, string iconPath, string appId) {
      IShellLinkW link = (IShellLinkW)new CShellLink();
      link.SetPath(targetPath);
      link.SetArguments(arguments ?? "");
      link.SetDescription("vscodexkit notifications");
      if (!String.IsNullOrEmpty(iconPath)) {
        link.SetIconLocation(iconPath, 0);
      }

      IPropertyStore propertyStore = (IPropertyStore)link;
      PROPERTYKEY appIdKey = new PROPERTYKEY();
      appIdKey.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
      appIdKey.pid = 5;

      PROPVARIANT appIdValue = new PROPVARIANT();
      appIdValue.vt = 31;
      appIdValue.p = Marshal.StringToCoTaskMemUni(appId);
      try {
        propertyStore.SetValue(ref appIdKey, ref appIdValue);
        propertyStore.Commit();
        ((IPersistFile)link).Save(shortcutPath, true);
      } finally {
        if (appIdValue.p != IntPtr.Zero) {
          Marshal.FreeCoTaskMem(appIdValue.p);
        }
      }
    }
  }
}
'@
  try {
    Add-Type -TypeDefinition $source -Language CSharp
    return $true
  } catch {
    return $false
  }
}
function Get-CodexAppId {
  if ([string]::IsNullOrWhiteSpace($env:CODEXPATCH_AUMID)) { return 'vscodexkit.VSCode' }
  return $env:CODEXPATCH_AUMID
}
function Ensure-CodexToastShortcut {
  $appId = Get-CodexAppId
  try {
    if (-not (Add-CodexShortcutTypes)) { return $appId }
    $programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
    if ([string]::IsNullOrWhiteSpace($programs)) { return $appId }
    if (-not (Test-Path -LiteralPath $programs)) {
      New-Item -ItemType Directory -Path $programs -Force | Out-Null
    }
    $shortcutPath = Join-Path $programs 'vscodexkit.lnk'
    $target = $env:CODEXPATCH_SHORTCUT_TARGET
    if ([string]::IsNullOrWhiteSpace($target) -or -not (Test-Path -LiteralPath $target)) {
      $target = Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    }
    $icon = $env:CODEXPATCH_SHORTCUT_ICON
    if ([string]::IsNullOrWhiteSpace($icon) -or -not (Test-Path -LiteralPath $icon)) {
      $icon = $target
    }
    [CodexPatchToast.Shortcut]::Create($shortcutPath, $target, '', $icon, $appId)
    Start-Sleep -Milliseconds 200
  } catch {}
  return $appId
}
function Show-CodexToast {
  try {
    $appId = Ensure-CodexToastShortcut
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $template.GetElementsByTagName('text')
    [void]$texts.Item(0).AppendChild($template.CreateTextNode($env:CODEXPATCH_TITLE))
    [void]$texts.Item(1).AppendChild($template.CreateTextNode($env:CODEXPATCH_BODY))
    $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
    $toast.Group = 'codexpatch'
    $toast.Tag = 'codexpatch-' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    $ids = @($appId, $env:CODEXPATCH_AUMID, 'Microsoft.VisualStudioCode', 'Microsoft.VisualStudioCodeInsiders', 'VSCodium.VSCodium') | Where-Object { $_ } | Select-Object -Unique
    foreach ($id in $ids) {
      try {
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show($toast)
        $script:shown = $true
        return $true
      } catch {}
    }
  } catch {}
  return $false
}
function Show-CodexBalloon {
  $n = $null
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $icon = if ($env:CODEXPATCH_ICON -eq 'Warning') { [System.Windows.Forms.ToolTipIcon]::Warning } else { [System.Windows.Forms.ToolTipIcon]::Info }
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = [System.Drawing.SystemIcons]::Information
    $n.BalloonTipIcon = $icon
    $n.BalloonTipTitle = $env:CODEXPATCH_TITLE
    $n.BalloonTipText = $env:CODEXPATCH_BODY
    $n.Visible = $true
    $n.ShowBalloonTip(7000)
    Start-Sleep -Milliseconds 7500
    $script:shown = $true
    return $true
  } catch {
    return $false
  } finally {
    if ($n -ne $null) { $n.Dispose() }
  }
}
function Show-CodexPopup {
  try {
    $shell = New-Object -ComObject WScript.Shell
    $icon = if ($env:CODEXPATCH_ICON -eq 'Warning') { 48 } else { 64 }
    [void]$shell.Popup($env:CODEXPATCH_BODY, 7, $env:CODEXPATCH_TITLE, $icon)
    $script:shown = $true
    return $true
  } catch {
    return $false
  }
}
[void](Show-CodexToast)
[void](Show-CodexBalloon)
if (-not $script:shown) { [void](Show-CodexPopup) }
`;

const V5_NOTIFICATION_HANDLER = `e.push(d.registerInternalNotificationHandler(Re=>{/* codexpatch:v5:turn-completed-windows-system-notify */if(Re.method==="turn/completed"){E.emit("turnComplete");try{let cfg=globalThis.__codexpatchSettings||{};if(cfg.notify!==false){let st=Re.params?.turn?.status,err=Re.params?.turn?.error,msg=err?.message||err?.detail||err?.code||"",ok=st==="completed",title="Codex",body=ok?"Codex 任务已完成":"Codex 任务结束: "+(st??"unknown")+(msg?": "+String(msg).slice(0,180):"");if(process.platform==="win32")try{let ps=${JSON.stringify(WINDOWS_SYSTEM_NOTIFY_PS)},cp=require("child_process"),p=cp.spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-Sta","-Command",ps],{windowsHide:true,detached:true,stdio:"ignore",env:{...process.env,CODEXPATCH_TITLE:title,CODEXPATCH_BODY:body,CODEXPATCH_ICON:ok?"Info":"Warning",CODEXPATCH_AUMID:"Microsoft.VisualStudioCode"}});p.unref?.()}catch(_){ok?ut.window.showInformationMessage(body):ut.window.showWarningMessage(body)}else ok?ut.window.showInformationMessage(body):ut.window.showWarningMessage(body)}}catch(_){}}}));`;

const WINDOWS_SYSTEM_NOTIFY_PS_V6 = WINDOWS_SYSTEM_NOTIFY_PS.replace(
  "[void](Show-CodexToast)\n[void](Show-CodexBalloon)\nif (-not $script:shown) { [void](Show-CodexPopup) }",
  "if (-not (Show-CodexToast)) {\n  if (-not (Show-CodexBalloon)) { [void](Show-CodexPopup) }\n}"
);

const WINDOWS_SYSTEM_NOTIFY_PS_V7 = WINDOWS_SYSTEM_NOTIFY_PS_V6;

const WINDOWS_SYSTEM_NOTIFY_PS_V8 = `
function Write-CodexPatchLog {
  param([string]$Message)
  try {
    $log = $env:CODEXPATCH_LOG_FILE
    if ([string]::IsNullOrWhiteSpace($log)) { $log = Join-Path $env:TEMP 'codexpatch.log' }
    $line = ('{0} [notify.ps1] {1}' -f [DateTimeOffset]::Now.ToString('o'), $Message)
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  } catch {}
}
Write-CodexPatchLog ('start event=' + $env:CODEXPATCH_EVENT + ' title=' + $env:CODEXPATCH_TITLE)
try {
${WINDOWS_SYSTEM_NOTIFY_PS_V7}
} catch {
  Write-CodexPatchLog ('fatal ' + $_.Exception.Message)
}
Write-CodexPatchLog ('end shown=' + $script:shown)
`;

const V6_NOTIFICATION_HANDLER = `e.push(d.registerInternalNotificationHandler(Re=>{/* codexpatch:v6:turn-completed-windows-toast-first */if(Re.method==="turn/completed"){E.emit("turnComplete");try{let cfg=globalThis.__codexpatchSettings||{};if(cfg.notify!==false){let st=Re.params?.turn?.status,err=Re.params?.turn?.error,msg=err?.message||err?.detail||err?.code||"",ok=st==="completed",title="Codex",body=ok?"Codex 任务已完成":"Codex 任务结束: "+(st??"unknown")+(msg?": "+String(msg).slice(0,180):"");if(process.platform==="win32")try{let ps=${JSON.stringify(WINDOWS_SYSTEM_NOTIFY_PS_V6)},cp=require("child_process"),p=cp.spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-Sta","-Command",ps],{windowsHide:true,detached:true,stdio:"ignore",env:{...process.env,CODEXPATCH_TITLE:title,CODEXPATCH_BODY:body,CODEXPATCH_ICON:ok?"Info":"Warning",CODEXPATCH_AUMID:"Microsoft.VisualStudioCode"}});p.unref?.()}catch(_){ok?ut.window.showInformationMessage(body):ut.window.showWarningMessage(body)}else ok?ut.window.showInformationMessage(body):ut.window.showWarningMessage(body)}}catch(_){}}}));`;

const V7_NOTIFICATION_HANDLER = `e.push(d.registerInternalNotificationHandler(Re=>{/* codexpatch:v7:turn-completed-windows-toast-history */if(Re.method==="turn/completed"){E.emit("turnComplete");try{let cfg=globalThis.__codexpatchSettings||{};if(cfg.notify!==false){let st=Re.params?.turn?.status,err=Re.params?.turn?.error,msg=err?.message||err?.detail||err?.code||"",ok=st==="completed",title="Codex",body=ok?"Codex 任务已完成":"Codex 任务结束: "+(st??"unknown")+(msg?": "+String(msg).slice(0,180):"");if(process.platform==="win32")try{let ps=${JSON.stringify(WINDOWS_SYSTEM_NOTIFY_PS_V7)},cp=require("child_process"),p=cp.spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-Sta","-Command",ps],{windowsHide:true,detached:true,stdio:"ignore",env:{...process.env,CODEXPATCH_TITLE:title,CODEXPATCH_BODY:body,CODEXPATCH_ICON:ok?"Info":"Warning",CODEXPATCH_AUMID:"vscodexkit.VSCode",CODEXPATCH_SHORTCUT_TARGET:process.execPath,CODEXPATCH_SHORTCUT_ICON:process.execPath}});p.unref?.()}catch(_){ok?ut.window.showInformationMessage(body):ut.window.showWarningMessage(body)}else ok?ut.window.showInformationMessage(body):ut.window.showWarningMessage(body)}}catch(_){}}}));`;

const V9_NOTIFICATION_HANDLER = `e.push((()=>{/* codexpatch:v9:conversation-end-all-known-states */
function cpText(e){return e==null?"":typeof e==="string"?e:typeof e==="number"?String(e):""}
function cpErr(e){return e==null?"":typeof e==="string"?e:cpText(e.message)||cpText(e.detail)||cpText(e.additionalDetails)||cpText(e.code)||cpText(e.error)}
function cpMsg(e){let r=e?.params||{},n=e?.error||r.error||r.turn?.error||r.payload?.error||r.event?.error;return cpErr(n)||cpText(e?.message)||cpText(r.message)||cpText(r.errorMessage)||cpText(r.reason)||cpText(r.details)}
function cpConv(e){let r=e?.params||{};return cpText(e?.conversationId)||cpText(e?.threadId)||cpText(r.conversationId)||cpText(r.threadId)||"global"}
function cpBody(e,r,n){if(e==="completed")return"Codex 任务已完成";let o=r==="codex/event/stream_error"?"Codex 网络错误，任务已停止":r==="codex/event/error"?"Codex 任务发生错误":e==="interrupted"?"Codex 任务已中断":e==="failed"?"Codex 任务失败":"Codex 任务结束: "+(e??"unknown");return n?o+": "+String(n).slice(0,180):o}
function cpFinal(e){return e==="completed"||e==="failed"||e==="interrupted"}
function cpActive(){return globalThis.__codexpatchActiveConversations||(globalThis.__codexpatchActiveConversations=new Set)}
function cpStart(e){try{let r=cpConv(typeof e==="string"?{conversationId:e}:e);cpActive().add(r);globalThis.__codexpatchNotifyLastByConversation?.delete(r)}catch(_){}}
function cpNotify(e){try{let r=globalThis.__codexpatchSettings||{};if(r.notify===false)return;let n=e?.status||e?.params?.turn?.status||"unknown";if(!cpFinal(n))return;let o=Date.now(),i=globalThis.__codexpatchNotifyLastByConversation||(globalThis.__codexpatchNotifyLastByConversation=new Map),s=cpConv(e),a=i.get(s);if(a&&o-a.at<5e3)return;for(let[e,r]of i)try{o-r.at>6e4&&i.delete(e)}catch(_){}i.set(s,{at:o,status:n});let c=e?.method||"",l=cpMsg(e),u=n==="completed",d="Codex",f=cpBody(n,c,l);if(process.platform==="win32")try{let e=${JSON.stringify(WINDOWS_SYSTEM_NOTIFY_PS_V7)},r=require("child_process"),n=r.spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-Sta","-Command",e],{windowsHide:true,detached:true,stdio:"ignore",env:{...process.env,CODEXPATCH_TITLE:d,CODEXPATCH_BODY:f,CODEXPATCH_ICON:u?"Info":"Warning",CODEXPATCH_AUMID:"vscodexkit.VSCode",CODEXPATCH_SHORTCUT_TARGET:process.execPath,CODEXPATCH_SHORTCUT_ICON:process.execPath}});n.unref?.()}catch(_){u?ut.window.showInformationMessage(f):ut.window.showWarningMessage(f)}else u?ut.window.showInformationMessage(f):ut.window.showWarningMessage(f)}catch(_){}}
function cpHandle(e,r){try{let n=e?.status||e?.params?.turn?.status||"unknown";if(n==="inProgress"){cpStart(e);return}if(!cpFinal(n))return;let o=cpConv(e);if(r&&!cpActive().has(o))return;cpActive().delete(o);cpNotify(e)}catch(_){}}
function cpPath(e){return Array.isArray(e)?e.map(cpText):typeof e==="string"?e.split(/[./]/):[]}
function cpPathLooksTurn(e){let r=cpPath(e);return r.some(e=>e==="turn"||e==="turns"||e==="conversationTurns"||e==="visibleTurnEntries"||e==="turnHistory")}
function cpFindStatus(e,r){if(r>6||e==null)return"";if(typeof e==="string")return cpFinal(e)||e==="inProgress"?e:"";if(typeof e!=="object")return"";if(typeof e.status==="string"&&(cpFinal(e.status)||e.status==="inProgress"))return e.status;if(Array.isArray(e)){for(let n=e.length-1;n>=0;n--){let o=cpFindStatus(e[n],r+1);if(o)return o}return""}for(let n of["turn","value","conversationState","latestTurn","entry"]){let o=cpFindStatus(e[n],r+1);if(o)return o}return""}
function cpLatestTurnStatus(e){let r=e?.turns||e?.conversationTurns||e?.visibleTurnEntries;if(Array.isArray(r))for(let e=r.length-1;e>=0;e--){let n=cpFindStatus(r[e],0);if(n)return n}return cpFindStatus(e,0)}
function cpStreamStatus(e){let r=e?.change||e?.params?.change||{};if(r.type==="snapshot")return cpLatestTurnStatus(r.conversationState);if(Array.isArray(r.patches)){let e="";for(let n of r.patches){if(!cpPathLooksTurn(n?.path))continue;let r=cpFindStatus(n?.value,0);if(!r&&cpPath(n?.path).at(-1)==="status")r=cpFindStatus(n?.value,0);if(cpFinal(r))return r;if(r==="inProgress")e=r}return e}return cpFindStatus(r,0)}
globalThis.__codexpatchNotifyConversationEnd=e=>cpHandle(e,false);
globalThis.__codexpatchNotifyConversationStart=cpStart;
globalThis.__codexpatchObserveThreadStreamState=e=>{try{let r=cpStreamStatus(e);r&&cpHandle({source:"thread-stream-state",method:"thread-stream-state-changed",conversationId:e?.conversationId,threadId:e?.conversationId,status:r,params:e},true)}catch(_){}};
return d.registerInternalNotificationHandler(Re=>{if(Re.method==="turn/completed"){E.emit("turnComplete");try{let e=Re.params||{},r=e.turn||{};cpHandle({source:"turn-completed",method:Re.method,conversationId:e.threadId,threadId:e.threadId,turnId:r.id,status:r.status,error:r.error,params:e},false)}catch(_){}}});
})());`;

const V10_NOTIFICATION_HANDLER = `e.push((()=>{/* codexpatch:v10:diagnostic-live-states */
function cpText(e){return e==null?"":typeof e==="string"?e:typeof e==="number"||typeof e==="boolean"?String(e):""}
function cpJson(e){try{return JSON.stringify(e,(r,n)=>typeof n==="string"&&n.length>240?n.slice(0,240)+"...":n)}catch(_){return""}}
function cpMod(){try{return{fs:require("fs"),os:require("os"),path:require("path"),cp:require("child_process")}}catch(_){return null}}
function cpLog(e,r){try{let n=cpMod();if(!n)return;let o=process.env.CODEXPATCH_LOG_FILE||n.path.join(n.os.tmpdir(),"codexpatch.log"),i=cpJson(r);n.fs.appendFileSync(o,new Date().toISOString()+" [host] "+e+(i?" "+i:"")+"\\n","utf8")}catch(_){}}
function cpErr(e){return e==null?"":typeof e==="string"?e:cpText(e.message)||cpText(e.detail)||cpText(e.additionalDetails)||cpText(e.code)||cpText(e.error)}
function cpMsg(e){let r=e?.params||{},n=e?.error||r.error||r.turn?.error||r.payload?.error||r.event?.error;return cpErr(n)||cpText(e?.body)||cpText(e?.message)||cpText(r.message)||cpText(r.errorMessage)||cpText(r.reason)||cpText(r.details)}
function cpConv(e){let r=e?.params||{};return cpText(e?.conversationId)||cpText(e?.threadId)||cpText(r.conversationId)||cpText(r.threadId)||"global"}
function cpHost(e){let r=e?.params||{};return cpText(e?.hostId)||cpText(r.hostId)||"local"}
function cpTurnId(e){let r=e?.params||{},n=r.change?.patch?.value||r.patch?.value||{};return cpText(e?.turnId)||cpText(r.turn?.id)||cpText(n.turnId)||""}
function cpModel(e){let r=e?.params||{},n=r.change?.patch?.value||r.patch?.value||{};return cpText(e?.model)||cpText(r.model)||cpText(r.turn?.params?.model)||cpText(n.params?.model)||cpText(n.model)||""}
function cpStatus(e){return e?.status||e?.params?.turn?.status||"unknown"}
function cpFinal(e){return e==="completed"||e==="failed"||e==="interrupted"}
function cpApproval(e){return e==="approval_needed"||e==="needs_approval"||e==="approval"||e==="input_needed"}
function cpAwaitingApprovalMethod(e){let r=cpText(e),n=r.toLowerCase();return r==="codex/event/exec_approval_request"||r==="codex/event/apply_patch_approval_request"||n==="item/commandexecution/requestapproval"||n==="item/filechange/requestapproval"||n==="item/permissions/requestapproval"||/(approval_request|requestapproval|request_approval|approvalrequest|permissions_request|permissionrequest)/i.test(r)}
function cpAwaitingInputMethod(e){let r=cpText(e),n=r.toLowerCase();return r==="codex/event/request_user_input"||r==="codex/event/elicitation_request"||r==="codex/event/dynamic_tool_call_request"||n==="item/tool/requestuserinput"||n==="item/tool/requestoptionpicker"||n==="item/tool/requestsetupcodexcontextpicker"||n==="item/plan/requestimplementation"||/(requestuserinput|request_user_input|requestoptionpicker|requestsetupcodexcontextpicker|requestimplementation|elicitation_request|dynamic_tool_call_request)/i.test(r)}
function cpAwaitingUserMethod(e){return cpAwaitingApprovalMethod(e)||cpAwaitingInputMethod(e)}
function cpAuthoritativeEnd(e){let r=e?.source||"",n=e?.method||"";return r==="turn-completed"||r==="mcp"||n==="turn/completed"||n==="codex/event/task_complete"||n==="codex/event/error"||n==="codex/event/stream_error"||n==="codex/event/turn_aborted"}
function cpMarkUserInterrupt(e){try{let r=cpConv(e),n=Date.now(),o=globalThis.__codexpatchUserInterrupts||(globalThis.__codexpatchUserInterrupts=new Map);if(!r||r==="global"){cpLog("user-interrupt-mark-skip",{conversationId:r,requestId:cpRequestId(e),method:e?.method});return}o.set(r,{at:n,requestId:cpRequestId(e),method:e?.method||""});for(let[e,r]of o)try{n-r.at>3e5&&o.delete(e)}catch(_){}cpLog("user-interrupt-mark",{conversationId:r,requestId:cpRequestId(e),source:e?.source,method:e?.method})}catch(r){cpLog("user-interrupt-mark-exception",{message:r?.message})}}
function cpRecentUserInterrupt(e){try{let r=cpConv(e),n=Date.now(),o=globalThis.__codexpatchUserInterrupts;if(!o||!r)return false;let i=o.get(r);if(i&&n-i.at<3e5)return true;i&&o.delete(r);return false}catch(_){return false}}
function cpLooksUserInterrupted(e){let r=(cpText(e?.method)+" "+cpMsg(e)).toLowerCase(),n=cpStatus(e),o=e?.method||"";if((n==="interrupted"||o==="codex/event/turn_aborted")&&cpRecentUserInterrupt(e))return true;return /user.*(interrupt|cancel|abort)|cancelled by user|canceled by user|aborted by user|用户.*(中断|取消)/.test(r)}
function cpRequestId(e){let r=e?.params||{};return cpText(e?.requestId)||cpText(e?.id)||cpText(r.requestId)||cpText(r.id)||cpText(r.callId)||cpText(r.itemId)||""}
function cpRetryBlob(e){let r=e?.params||{},n=[e?.source,e?.method,cpStatus(e),cpMsg(e),e?.error?.code,r.error?.code,r.turn?.error?.code,r.reason,r.details,r.errorMessage,cpJson(e?.error),cpJson(e?.change),cpJson(r.change),cpJson(r.error),cpJson(r.turn?.error),cpJson(r.payload?.error),cpJson(r.event?.error)].join(" ");return n.slice(0,12e3).toLowerCase()}
function cpLooksStreamRetryExhausted(e){let r=cpRetryBlob(e),n=(cpText(e?.source)+" "+cpText(e?.method)).toLowerCase(),o=/stream_error|thread-stream-state/.test(n)||/\\bstream\\b|stream[_ -]?/.test(r),i=cpStatus(e)==="failed"&&/(currently experiencing high demand|temporary errors?|temporarily unavailable|service unavailable|overloaded|too many requests|rate limit|\\b429\\b|\\b502\\b|\\b503\\b|\\b504\\b|gateway timeout|network error|fetch failed|failed to fetch|connection (?:reset|refused|closed)|econnreset|etimedout|eai_again|enotfound|timed?\\s*out)/.test(r);if(/stream[_ -]?max[_ -]?retries/.test(r))return true;if(i)return true;if(!o)return false;return /max(?:imum)?\\s+retries|retry limit|retries exhausted|exhausted\\s+retries|too many retries|retry attempts? exhausted|all retries failed/.test(r)}
function cpRequestAutoRetry(e){try{let r=globalThis.__codexpatchSettings||{};if(r.autoRetry!==true){cpLog("auto-retry-skip-disabled",{conversationId:cpConv(e),status:cpStatus(e),method:e?.method});return false}if(cpLooksUserInterrupted(e)){cpLog("auto-retry-skip-user-interrupt",{conversationId:cpConv(e),status:cpStatus(e),method:e?.method});return false}if(!cpLooksStreamRetryExhausted(e)){cpLog("auto-retry-skip-not-stream-max-retries",{conversationId:cpConv(e),status:cpStatus(e),method:e?.method,msg:cpMsg(e)});return false}let n=cpConv(e),o=cpTurnId(e),i=cpHost(e),s=cpModel(e),a=n+"|"+(o||cpRequestId(e)||cpMsg(e).slice(0,80))+"|"+cpStatus(e)+"|"+(e?.method||""),c=Date.now(),l=globalThis.__codexpatchAutoRetryLast||(globalThis.__codexpatchAutoRetryLast=new Map),u=l.get(a);if(u&&c-u<3e4){cpLog("auto-retry-skip-duplicate",{key:a});return true}for(let[e,r]of l)try{c-r>12e4&&l.delete(e)}catch(_){}let f={type:"codexpatch-auto-retry",hostId:i,conversationId:n,threadId:n,turnId:o,model:s||null,status:cpStatus(e),method:e?.method||"",reason:"stream_max_retries",windowMs:3e4,at:c},p=globalThis.__codexpatchBroadcastToWebview;if(typeof p==="function"){cpLog("auto-retry-arm",f);p(f);l.set(a,c);return true}else cpLog("auto-retry-no-broadcast",f);return false}catch(r){cpLog("auto-retry-exception",{message:r?.message});return false}}
function cpBody(e,r,n,o){if(o==="approval"||cpApproval(e)||cpAwaitingUserMethod(r)){if(cpAwaitingInputMethod(r))return n||"Codex 需要你回复问题";return n||"Codex 需要你审批操作"}if(e==="completed")return"Codex 任务已完成";let i=r==="codex/event/stream_error"?"Codex 网络错误，任务已停止":r==="codex/event/error"?"Codex 任务发生错误":e==="interrupted"?"Codex 任务已中断":e==="failed"?"Codex 任务失败":"Codex 任务结束: "+(e??"unknown");return n?i+": "+String(n).slice(0,180):i}
function cpNotify(e){try{let r=globalThis.__codexpatchSettings||{};if(r.notify===false){cpLog("notify-skip-disabled",e);return}let n=cpStatus(e),o=e?.kind||"",i=e?.method||"",s=cpApproval(n)||o==="approval"||cpAwaitingUserMethod(i);if(!s&&!cpFinal(n)){cpLog("notify-skip-not-final",{status:n,kind:o,method:i});return}if(!s&&cpLooksUserInterrupted(e)){cpLog("notify-skip-user-interrupt",{status:n,method:i,msg:cpMsg(e)});return}let a=Date.now(),c=globalThis.__codexpatchNotifyLastByConversation||(globalThis.__codexpatchNotifyLastByConversation=new Map),l=cpConv(e),u=s?"approval":n,d=l+"|"+u+"|"+i+"|"+cpRequestId(e),f=c.get(d);if(f&&a-f<1e4){cpLog("notify-skip-duplicate",{key:d,status:n,kind:o});return}for(let[e,r]of c)try{a-r>12e4&&c.delete(e)}catch(_){}c.set(d,a);let p=cpMsg(e),h=s?"Codex 需要处理":"Codex",g=cpBody(n,i,p,o),m=s||n!=="completed";cpLog("notify-send",{conversationId:l,status:n,kind:o,method:i,body:g});if(process.platform==="win32")try{let e=${JSON.stringify(WINDOWS_SYSTEM_NOTIFY_PS_V8)},r=cpMod(),o=r.path.join(r.os.tmpdir(),"codexpatch-notify.ps1");try{r.fs.writeFileSync(o,e,"utf8");cpLog("notify-script-written",{path:o,bytes:e.length})}catch(e){cpLog("notify-script-write-failed",{message:e?.message})}let n=r.cp.spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-Sta","-File",o],{windowsHide:true,detached:false,stdio:["ignore","ignore","pipe"],env:{...process.env,CODEXPATCH_TITLE:h,CODEXPATCH_BODY:g,CODEXPATCH_ICON:m?"Warning":"Info",CODEXPATCH_EVENT:u,CODEXPATCH_AUMID:"vscodexkit.VSCode",CODEXPATCH_LOG_FILE:process.env.CODEXPATCH_LOG_FILE||r.path.join(r.os.tmpdir(),"codexpatch.log"),CODEXPATCH_SHORTCUT_TARGET:process.execPath,CODEXPATCH_SHORTCUT_ICON:process.execPath}});cpLog("notify-spawned",{pid:n.pid,event:u,file:o});n.stderr?.on?.("data",e=>cpLog("notify-stderr",{message:String(e).slice(0,500)}));n.on?.("exit",(e,r)=>cpLog("notify-exit",{code:e,signal:r,event:u}));n.on?.("error",e=>cpLog("notify-spawn-error",{message:e?.message}));return}catch(e){cpLog("notify-spawn-exception",{message:e?.message})}m?ut.window.showWarningMessage(g):ut.window.showInformationMessage(g)}catch(e){cpLog("notify-exception",{message:e?.message})}}
function cpStart(e){try{let r=cpConv(typeof e==="string"?{conversationId:e}:e);(globalThis.__codexpatchActiveConversations||(globalThis.__codexpatchActiveConversations=new Set)).add(r);cpLog("conversation-start",{conversationId:r,source:e?.source,method:e?.method})}catch(_){}}
function cpHandle(e){try{let r=cpStatus(e),n=e?.method||"";cpLog("observe",{source:e?.source,method:n,status:r,conversationId:cpConv(e),kind:e?.kind});if(r==="inProgress"){cpStart(e);return}if(cpFinal(r)&&!cpAuthoritativeEnd(e)){cpLog("notify-skip-nonauthoritative-final",{source:e?.source,method:n,status:r,conversationId:cpConv(e)});return}let o=false;if(r==="failed"||n==="codex/event/stream_error"||n==="codex/event/error")o=cpRequestAutoRetry(e);if(o){cpLog("notify-skip-auto-retry",{conversationId:cpConv(e),status:r,method:n,msg:cpMsg(e)});return}if(cpFinal(r)||cpApproval(r)||e?.kind==="approval"||cpAwaitingUserMethod(n))cpNotify(e)}catch(n){cpLog("handle-exception",{message:n?.message})}}
function cpPath(e){return Array.isArray(e)?e.map(cpText):typeof e==="string"?e.split(/[./]/):[]}
function cpPathLooksTurn(e){let r=cpPath(e);return r.some(e=>e==="turn"||e==="turns"||e==="conversationTurns"||e==="visibleTurnEntries"||e==="turnHistory"||e==="latestTurn")}
function cpFindStatus(e,r){if(r>7||e==null)return"";if(typeof e==="string")return cpFinal(e)||e==="inProgress"?e:"";if(typeof e!=="object")return"";if(typeof e.status==="string"&&(cpFinal(e.status)||e.status==="inProgress"))return e.status;if(Array.isArray(e)){for(let n=e.length-1;n>=0;n--){let o=cpFindStatus(e[n],r+1);if(o)return o}return""}for(let n of["turn","value","conversationState","latestTurn","entry","payload"]){let o=cpFindStatus(e[n],r+1);if(o)return o}return""}
function cpObserveStreamFinalForRetry(e){try{let r=e?.change||e?.params?.change||{};if(r.type==="snapshot"){let n=cpFindStatus(r.conversationState,0);if(n==="failed")cpRequestAutoRetry({source:"thread-stream-state-final",method:"thread-stream-state-changed",conversationId:e?.conversationId,threadId:e?.conversationId,status:n,params:{change:r}});return}if(Array.isArray(r.patches)){for(let n of r.patches){if(!cpPathLooksTurn(n?.path))continue;let o=cpFindStatus(n?.value,0);if(!o&&cpPath(n?.path).at(-1)==="status")o=cpFindStatus(n?.value,0);if(o==="failed")cpRequestAutoRetry({source:"thread-stream-state-final",method:"thread-stream-state-changed",conversationId:e?.conversationId,threadId:e?.conversationId,status:o,error:n?.value?.error,params:{change:{type:r.type,patch:n}}})}return}let n=cpFindStatus(r,0);if(n==="failed")cpRequestAutoRetry({source:"thread-stream-state-final",method:"thread-stream-state-changed",conversationId:e?.conversationId,threadId:e?.conversationId,status:n,params:{change:r}})}catch(r){cpLog("stream-final-retry-exception",{message:r?.message})}}
function cpStreamInfo(e){let r=e?.change||e?.params?.change||{},n={status:"",snapshot:r.type==="snapshot"};if(r.type==="snapshot"){let e=cpFindStatus(r.conversationState,0);if(e==="inProgress")n.status=e;else if(cpFinal(e))cpLog("stream-final-ignored",{status:e,snapshot:true});return n}if(Array.isArray(r.patches)){for(let e of r.patches){if(!cpPathLooksTurn(e?.path))continue;let r=cpFindStatus(e?.value,0);if(!r&&cpPath(e?.path).at(-1)==="status")r=cpFindStatus(e?.value,0);if(cpFinal(r)){cpLog("stream-final-ignored",{status:r,path:cpPath(e?.path).join(".")});continue}if(r==="inProgress"&&!n.status)n.status=r}return n}let o=cpFindStatus(r,0);if(o==="inProgress")n.status=o;else if(cpFinal(o))cpLog("stream-final-ignored",{status:o});return n}
function cpObserveAppServerRequest(e){try{let r=cpText(e?.method),n=e?.params||{},o=cpText(n.conversationId)||cpText(n.threadId)||cpText(e?.conversationId)||cpText(e?.threadId)||"global",i=cpText(e?.id)||cpRequestId({params:n});cpLog("app-request-observe",{method:r,conversationId:o,requestId:i});if(!cpAwaitingUserMethod(r))return;let s=cpAwaitingInputMethod(r)?"input_needed":"approval_needed";cpHandle({source:"app-server-request",method:r,conversationId:o,threadId:o,requestId:i,status:s,kind:"approval",params:n})}catch(r){cpLog("app-request-observe-exception",{message:r?.message})}}
globalThis.__codexpatchLog=cpLog;
globalThis.__codexpatchNotifySystem=cpNotify;
globalThis.__codexpatchNotifyConversationEnd=e=>cpHandle(e);
globalThis.__codexpatchNotifyConversationStart=cpStart;
globalThis.__codexpatchMarkUserInterrupt=cpMarkUserInterrupt;
globalThis.__codexpatchObserveAppServerRequest=cpObserveAppServerRequest;
globalThis.__codexpatchObserveThreadStreamState=e=>{try{cpObserveStreamFinalForRetry(e);let r=cpStreamInfo(e);if(r.status==="inProgress")cpHandle({source:"thread-stream-state",method:"thread-stream-state-changed",conversationId:e?.conversationId,threadId:e?.conversationId,status:r.status,params:e,snapshot:r.snapshot})}catch(r){cpLog("stream-observe-exception",{message:r?.message})}};
cpLog("loaded",{version:${JSON.stringify(VERSION)}});
return d.registerInternalNotificationHandler(Re=>{if(Re.method==="turn/completed"){E.emit("turnComplete");try{let e=Re.params||{},r=e.turn||{};cpHandle({source:"turn-completed",method:Re.method,conversationId:e.threadId,threadId:e.threadId,turnId:r.id,status:r.status,error:r.error,params:e})}catch(e){cpLog("turn-completed-exception",{message:e?.message})}}});
})());`;

const MCP_LIFECYCLE_ANCHOR =
  'handleMcpNotification(e){let r=this.extractConversationId(e.params);if(r)switch(e.method){case"codex/event/task_started":this.updateConversationStatus(r,2);break;case"codex/event/task_complete":this.updateConversationStatus(r,1);break;case"codex/event/turn_aborted":case"codex/event/error":case"codex/event/stream_error":this.updateConversationStatus(r,0);break;default:break}}';

const MCP_LIFECYCLE_PATCH =
  'handleMcpNotification(e){let r=this.extractConversationId(e.params);switch(e.method){case"codex/event/exec_approval_request":case"codex/event/apply_patch_approval_request":globalThis.__codexpatchNotifyConversationEnd?.({source:"mcp",method:e.method,conversationId:r||"global",status:"approval_needed",kind:"approval",params:e.params});break;case"codex/event/request_user_input":case"codex/event/elicitation_request":case"codex/event/dynamic_tool_call_request":globalThis.__codexpatchNotifyConversationEnd?.({source:"mcp",method:e.method,conversationId:r||"global",status:"input_needed",kind:"approval",params:e.params});break;case"codex/event/task_started":if(r)this.updateConversationStatus(r,2),globalThis.__codexpatchNotifyConversationStart?.(r);break;case"codex/event/task_complete":if(r)this.updateConversationStatus(r,1),globalThis.__codexpatchNotifyConversationEnd?.({source:"mcp",method:e.method,conversationId:r,status:"completed",params:e.params});break;case"codex/event/turn_aborted":if(r)globalThis.__codexpatchNotifyConversationEnd?.({source:"mcp",method:e.method,conversationId:r,status:"interrupted",params:e.params}),this.updateConversationStatus(r,0);break;case"codex/event/error":case"codex/event/stream_error":if(r)globalThis.__codexpatchNotifyConversationEnd?.({source:"mcp",method:e.method,conversationId:r,status:"failed",params:e.params}),this.updateConversationStatus(r,0);break;default:break}}/* codexpatch:v1:mcp-lifecycle-conversation-end */';

const APP_SERVER_REQUEST_ANCHOR =
  'onRequest:T=>{this.broadcastToAllViews({type:"mcp-request",hostId:"local",request:T})}';

const APP_SERVER_REQUEST_PATCH =
  'onRequest:T=>{try{globalThis.__codexpatchBroadcastToWebview=O=>{try{this.broadcastToAllViews(O)}catch(e){globalThis.__codexpatchLog?.("broadcast-exception",{message:e?.message})}};globalThis.__codexpatchObserveAppServerRequest?.(T)}catch(_){}this.broadcastToAllViews({type:"mcp-request",hostId:"local",request:T})}/* codexpatch:v1:app-server-request-approval */';

const THREAD_STREAM_STATE_ANCHOR =
  'case"thread-stream-state-changed":{let n=this.getIpcClientForWebview(e);if(!n)throw new Error("Missing IPC client for webview");await n.sendBroadcast("thread-stream-state-changed",r);break}';

const THREAD_STREAM_STATE_PATCH =
  'case"thread-stream-state-changed":{/* codexpatch:v1:thread-stream-state-conversation-end */try{globalThis.__codexpatchBroadcastToWebview=O=>{try{this.broadcastToAllViews(O)}catch(e){globalThis.__codexpatchLog?.("broadcast-exception",{message:e?.message})}};globalThis.__codexpatchObserveThreadStreamState?.(r)}catch(_){}let n=this.getIpcClientForWebview(e);if(!n)throw new Error("Missing IPC client for webview");await n.sendBroadcast("thread-stream-state-changed",r);break}';

const USER_INTERRUPT_ANCHOR =
  'c=r.addRequestHandler("thread-follower-interrupt-turn",async x=>await this.getThreadRole(e,x.conversationId)==="owner",async x=>this.handleThreadFollowerInterruptTurnRequest(e,x.requestId,x.params)),';

const USER_INTERRUPT_PATCH =
  'c=r.addRequestHandler("thread-follower-interrupt-turn",async x=>await this.getThreadRole(e,x.conversationId)==="owner",async x=>(globalThis.__codexpatchMarkUserInterrupt?.({source:"thread-follower",method:"thread-follower-interrupt-turn",conversationId:x.conversationId,requestId:x.requestId,params:x.params}),this.handleThreadFollowerInterruptTurnRequest(e,x.requestId,x.params))),/* codexpatch:v1:user-interrupt-suppress */';

const HOST_MESSAGE_ANCHOR =
  'switch(r.type){case"ready":break;case"persisted-atom-sync-request":';

const V2_HOST_MESSAGE_PATCH =
  'switch(r.type){case"codexpatch-settings-update":{/* codexpatch:v2:host-settings */try{let n=r.settings||{};globalThis.__codexpatchSettings={notify:n.notify!==false,autoRetry:n.autoRetry===true,maxRetries:Number(n.maxRetries)||5,retryDelayMs:Number(n.retryDelayMs)||1500}}catch(_){}break}case"ready":break;case"persisted-atom-sync-request":';

const HOST_MESSAGE_PATCH =
  'switch(r.type){case"codexpatch-settings-update":{/* codexpatch:v3:host-settings */try{globalThis.__codexpatchBroadcastToWebview=O=>{try{this.broadcastToAllViews(O)}catch(e){globalThis.__codexpatchLog?.("broadcast-exception",{message:e?.message})}};let n=r.settings||{};globalThis.__codexpatchSettings={notify:n.notify!==false,autoRetry:n.autoRetry!==false,retryDelayMs:Number(n.retryDelayMs)||1500};globalThis.__codexpatchLog?.("settings-update",globalThis.__codexpatchSettings)}catch(_){}break}case"codexpatch-user-interrupt":{try{globalThis.__codexpatchMarkUserInterrupt?.({source:"webview",method:r.method||"codexpatch-user-interrupt",conversationId:r.conversationId,threadId:r.threadId,turnId:r.turnId,requestId:r.requestId,params:r})}catch(e){globalThis.__codexpatchLog?.("webview-user-interrupt-exception",{message:e?.message})}break}case"codexpatch-notify":{try{globalThis.__codexpatchNotifySystem?.({source:"webview",method:"codexpatch/"+(r.kind||"notify"),conversationId:r.conversationId,status:r.status||"approval_needed",kind:r.kind||"info",message:r.message||r.body||"",body:r.body||r.message||""})}catch(e){globalThis.__codexpatchLog?.("webview-notify-exception",{message:e?.message})}break}case"codexpatch-diagnostic":{try{globalThis.__codexpatchLog?.("webview-"+(r.event||"event"),r)}catch(_){}break}case"ready":break;case"persisted-atom-sync-request":';

const WEBVIEW_SCRIPT_ANCHOR =
  '<script type="module" crossorigin src="./assets/index-D6d_BZFy.js"></script>';

const WEBVIEW_SCRIPT_PATCH =
  '<script type="module" crossorigin src="./assets/codexpatch-ui.js"></script><!-- codexpatch:v2:webview-index -->\n    <script type="module" crossorigin src="./assets/index-D6d_BZFy.js"></script>';

const WEBVIEW_UI_SOURCE = `/* codexpatch:v7:webview-ui */
(() => {
  const KEY = "codexpatch.settings";
  const DEFAULTS = { notify: true, autoRetry: false, retryDelayMs: 1500 };
  const MODEL_MENU_MARKERS = "[data-reasoning-slider],[data-reasoning-selected],[data-model-selected]";
  const PRIMARY_MODEL_MENU_MARKERS = "[data-reasoning-slider],[data-reasoning-selected]";
  let vscodeApi = null;
  let lastRetrySignature = "";
  let pendingRetryTimer = null;
  let lastRetryClickAt = 0;
  let menuRenderQueued = false;
  let retryScanQueued = false;

  function readSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
      return {
        notify: saved.notify !== false,
        autoRetry: saved.autoRetry === true,
        retryDelayMs: Number(saved.retryDelayMs) || DEFAULTS.retryDelayMs
      };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }

  function writeSettings(next) {
    localStorage.setItem(KEY, JSON.stringify(next));
    syncSettings();
    renderState(next);
  }

  function updateSettings(patch) {
    writeSettings({ ...readSettings(), ...patch });
  }

  function getVsCodeApi() {
    return vscodeApi || window.__codexpatchVsCodeApi || null;
  }

  function syncSettings() {
    const api = getVsCodeApi();
    if (!api || typeof api.postMessage !== "function") return;
    try {
      api.postMessage({ type: "codexpatch-settings-update", settings: readSettings() });
    } catch (_) {}
  }

  function wrapAcquireVsCodeApi() {
    const original = window.acquireVsCodeApi;
    if (typeof original !== "function" || window.__codexpatchAcquireWrapped) return;
    window.acquireVsCodeApi = function wrappedAcquireVsCodeApi(...args) {
      const api = original.apply(this, args);
      vscodeApi = api;
      window.__codexpatchVsCodeApi = api;
      setTimeout(syncSettings, 0);
      return api;
    };
    window.__codexpatchAcquireWrapped = true;
  }

  function injectStyle() {
    if (document.getElementById("codexpatch-style")) return;
    const style = document.createElement("style");
    style.id = "codexpatch-style";
    style.textContent = [
      "#codexpatch-dropdown-section{display:flex;flex-direction:column;width:100%;min-width:0;font:inherit;color:var(--color-token-foreground,var(--vscode-foreground,#d4d4d4));}",
      "#codexpatch-dropdown-section .codexpatch-separator{box-sizing:border-box;width:100%;padding:var(--padding-row-y,4px) var(--padding-row-x,8px);}",
      "#codexpatch-dropdown-section .codexpatch-separator::before{content:'';display:block;height:1px;width:100%;background:var(--color-token-menu-border,var(--vscode-menu-separatorBackground,rgb(255 255 255 / .12)));}",
      "#codexpatch-dropdown-section .codexpatch-title{display:flex;min-height:24px;align-items:center;overflow:hidden;padding:var(--padding-row-y,4px) var(--padding-row-x,8px);color:var(--color-token-description-foreground,var(--vscode-descriptionForeground,#858585));font-size:12px;line-height:16px;white-space:nowrap;text-overflow:ellipsis;}",
      "#codexpatch-dropdown-section .codexpatch-item{box-sizing:border-box;width:100%;min-height:28px;border:0;border-radius:8px;background:transparent;padding:var(--padding-row-y,4px) var(--padding-row-x,8px);color:var(--color-token-foreground,var(--vscode-foreground,#d4d4d4));font:inherit;font-size:13px;text-align:left;cursor:pointer;outline:0;}",
      "#codexpatch-dropdown-section .codexpatch-item:hover,#codexpatch-dropdown-section .codexpatch-item:focus-visible{background:var(--color-token-list-hover-background,var(--vscode-list-hoverBackground,rgb(255 255 255 / .08)));}",
      "#codexpatch-dropdown-section .codexpatch-item-content{display:flex;width:100%;min-width:0;align-items:center;gap:8px;}",
      "#codexpatch-dropdown-section .codexpatch-label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      "#codexpatch-dropdown-section .codexpatch-state{flex:0 0 auto;color:var(--color-token-description-foreground,var(--vscode-descriptionForeground,#858585));font-size:12px;}"
    ].join("");
    document.head.appendChild(style);
  }

  function removeLegacyStandaloneMenu() {
    document.getElementById("codexpatch-menu")?.remove();
    document.getElementById("codexpatch-popover")?.remove();
  }

  function findIntelligenceTrigger() {
    const marker = document.querySelector("[data-codex-intelligence-trigger]");
    if (!marker) return null;
    let node = marker;
    while (node && node !== document.documentElement) {
      if (node.getAttribute?.("aria-controls") && isVisible(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function findControlledMenu(trigger) {
    if (!trigger) return null;
    let node = trigger;
    while (node && node !== document.documentElement) {
      const contentId = node.getAttribute?.("aria-controls");
      if (contentId) {
        const byId = document.getElementById(contentId);
        if (byId && isVisible(byId) && !byId.closest("#codexpatch-dropdown-section")) return byId;
      }
      node = node.parentElement;
    }
    return null;
  }

  function findModelMenuContent() {
    const trigger = findIntelligenceTrigger();
    const controlled = findControlledMenu(trigger);
    if (isModelMenuContent(controlled)) return controlled;
    return findMenuContainingModelMarker(PRIMARY_MODEL_MENU_MARKERS) ||
      findMenuContainingModelMarker(MODEL_MENU_MARKERS);
  }

  function isModelMenuContent(menu) {
    return !!menu && isVisible(menu) && !!menu.querySelector(MODEL_MENU_MARKERS);
  }

  function findMenuContainingModelMarker(selector) {
    const markers = Array.from(document.querySelectorAll(selector));
    for (const marker of markers) {
      if (!isVisible(marker)) continue;
      const menu = marker.closest('[role="menu"]');
      if (menu && isVisible(menu) && !menu.closest("#codexpatch-dropdown-section")) return menu;
    }
    return null;
  }

  function injectModelMenuSection() {
    removeLegacyStandaloneMenu();
    const menu = findModelMenuContent();
    let section = document.getElementById("codexpatch-dropdown-section");
    if (!menu) {
      if (section) section.remove();
      return;
    }

    if (section && section.parentElement !== menu) section.remove();
    if (!section) {
      section = document.createElement("div");
      section.id = "codexpatch-dropdown-section";
      section.innerHTML = [
        '<div class="codexpatch-separator" aria-hidden="true"></div>',
        '<div class="codexpatch-title">vscodexkit</div>',
        '<button class="codexpatch-item" type="button" role="menuitemcheckbox" tabindex="-1" data-codexpatch-action="notify">',
        '<span class="codexpatch-item-content"><span class="codexpatch-label">自动通知</span><span class="codexpatch-state"></span></span>',
        '</button>',
        '<button class="codexpatch-item" type="button" role="menuitemcheckbox" tabindex="-1" data-codexpatch-action="autoretry">',
        '<span class="codexpatch-item-content"><span class="codexpatch-label">自动 Retry</span><span class="codexpatch-state"></span></span>',
        '</button>'
      ].join("");
      section.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });
      section.addEventListener("click", (event) => {
        const item = event.target.closest("[data-codexpatch-action]");
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        toggleMenuItem(item.getAttribute("data-codexpatch-action"));
      });
      section.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const item = event.target.closest("[data-codexpatch-action]");
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        toggleMenuItem(item.getAttribute("data-codexpatch-action"));
      });
    }
    if (section.parentElement !== menu) {
      menu.appendChild(section);
    }
    renderState(readSettings());
  }

  function toggleMenuItem(action) {
    const settings = readSettings();
    if (action === "notify") {
      updateSettings({ notify: settings.notify === false });
    } else if (action === "autoretry") {
      updateSettings({ autoRetry: settings.autoRetry !== true });
    }
  }

  function renderState(settings) {
    const states = {
      notify: settings.notify !== false,
      autoretry: settings.autoRetry === true
    };
    for (const [action, enabled] of Object.entries(states)) {
      const item = document.querySelector('[data-codexpatch-action="' + action + '"]');
      if (!item) continue;
      const enabledText = String(enabled);
      if (item.getAttribute("aria-checked") !== enabledText) item.setAttribute("aria-checked", enabledText);
      if (item.dataset.enabled !== enabledText) item.dataset.enabled = enabledText;
      const state = item.querySelector(".codexpatch-state");
      const label = enabled ? "开" : "关";
      if (state && state.textContent !== label) state.textContent = label;
    }
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function getElementLabel(element) {
    return [
      element.textContent || "",
      element.getAttribute("aria-label") || "",
      element.getAttribute("title") || "",
      element.getAttribute("data-testid") || "",
      element.getAttribute("data-test-id") || ""
    ].join(" ").replace(/\\s+/g, " ").trim().toLowerCase();
  }

  function buttonSignature(button) {
    return [getElementLabel(button), location.pathname, location.hash].join("|");
  }

  function retryButtonScore(button) {
    const label = getElementLabel(button);
    if (!label) return 0;
    if (/^(retry|try again|重试|再试一次|重新尝试)$/.test(label)) return 100;
    if (/(^|\\b)(retry|try again)(\\b|$)/.test(label)) return 80;
    if (/重试|再试一次|重新尝试/.test(label)) return 80;
    return 0;
  }

  function findRetryButton() {
    const candidates = Array.from(document.querySelectorAll("button,[role='button']"));
    let best = null;
    let bestScore = 0;
    for (const button of candidates) {
      if (!button || button.closest("#codexpatch-dropdown-section")) continue;
      if (button.disabled || button.getAttribute("aria-disabled") === "true") continue;
      if (!isVisible(button)) continue;
      const score = retryButtonScore(button);
      if (score > bestScore) {
        best = button;
        bestScore = score;
      }
    }
    return best;
  }

  function maybeAutoRetry() {
    const settings = readSettings();
    if (settings.autoRetry !== true) return;
    const button = findRetryButton();
    if (!button) {
      lastRetrySignature = "";
      return;
    }
    const signature = buttonSignature(button);
    const now = Date.now();
    if (signature === lastRetrySignature && now - lastRetryClickAt < 10000) return;
    if (pendingRetryTimer) return;
    pendingRetryTimer = window.setTimeout(() => {
      pendingRetryTimer = null;
      const latest = findRetryButton();
      if (!latest || buttonSignature(latest) !== signature) return;
      lastRetrySignature = signature;
      lastRetryClickAt = Date.now();
      latest.click();
    }, Number(settings.retryDelayMs) || 1500);
  }

  function startAutoRetryObserver() {
    const observer = new MutationObserver(() => {
      scheduleModelMenuInjection();
      scheduleAutoRetryScan();
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    window.setInterval(scheduleModelMenuInjection, 1000);
    window.setInterval(scheduleAutoRetryScan, 1500);
  }

  function scheduleModelMenuInjection() {
    if (menuRenderQueued) return;
    menuRenderQueued = true;
    const run = () => {
      menuRenderQueued = false;
      injectModelMenuSection();
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(run);
    } else {
      window.setTimeout(run, 0);
    }
  }

  function scheduleAutoRetryScan() {
    if (retryScanQueued) return;
    retryScanQueued = true;
    window.setTimeout(() => {
      retryScanQueued = false;
      maybeAutoRetry();
    }, 250);
  }

  function boot() {
    if (window.__codexpatchBooted) return;
    window.__codexpatchBooted = true;
    wrapAcquireVsCodeApi();
    injectStyle();
    removeLegacyStandaloneMenu();
    injectModelMenuSection();
    syncSettings();
    startAutoRetryObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
`;

const WEBVIEW_UI_SOURCE_LITE = `/* codexpatch:v8:webview-ui-diagnostic-lite */
(() => {
  const SETTINGS = { notify: true, autoRetry: true, retryDelayMs: 1500 };
  let vscodeApi = null;
  let pendingRetryTimer = null;
  let retryScanQueued = false;
  let lastRetrySignature = "";
  let lastRetryClickAt = 0;
  let autoRetryArmedUntil = 0;
  let autoRetryArmId = "";
  let lastAutoRetryExpiredLogAt = 0;

  function getApi() {
    return vscodeApi || window.__codexpatchVsCodeApi || null;
  }

  function post(message) {
    const api = getApi();
    if (!api || typeof api.postMessage !== "function") return false;
    try {
      api.postMessage(message);
      return true;
    } catch (_) {
      return false;
    }
  }

  function postUserInterrupt(payload = {}) {
    const message = { type: "codexpatch-user-interrupt", source: "webview", ...payload };
    const ok = post(message);
    if (ok) diag("user-interrupt-post", {
      conversationId: payload.conversationId || payload.threadId || "",
      method: payload.method || "unknown"
    });
    return ok;
  }

  window.__codexpatchPostUserInterrupt = postUserInterrupt;

  function diag(event, extra = {}) {
    post({ type: "codexpatch-diagnostic", event, ...extra });
  }

  function syncSettings() {
    post({ type: "codexpatch-settings-update", settings: SETTINGS });
  }

  function isAutoRetryArmed() {
    const now = Date.now();
    if (autoRetryArmedUntil > now) return true;
    if (autoRetryArmedUntil > 0) {
      if (now - lastAutoRetryExpiredLogAt > 5000) {
        diag("auto-retry-expired", { armId: autoRetryArmId });
        lastAutoRetryExpiredLogAt = now;
      }
      autoRetryArmedUntil = 0;
      autoRetryArmId = "";
    }
    return false;
  }

  function armAutoRetry(message) {
    if (SETTINGS.autoRetry !== true) {
      diag("auto-retry-arm-skip-disabled", {
        conversationId: message.conversationId || message.threadId || "",
        reason: message.reason || ""
      });
      return;
    }
    const windowMs = Math.max(5000, Number(message.windowMs) || 30000);
    autoRetryArmedUntil = 0;
    autoRetryArmId = "";
    lastRetrySignature = "";
    diag("auto-retry-direct-only", {
      conversationId: message.conversationId || message.threadId || "",
      turnId: message.turnId || "",
      reason: message.reason || "",
      windowMs
    });
  }

  function handleHostMessage(event) {
    const message = event.data;
    if (!message || message.type !== "codexpatch-auto-retry") return;
    armAutoRetry(message);
  }

  function wrapAcquireVsCodeApi() {
    const original = window.acquireVsCodeApi;
    if (typeof original !== "function" || window.__codexpatchAcquireWrapped) return;
    window.acquireVsCodeApi = function wrappedAcquireVsCodeApi(...args) {
      const api = original.apply(this, args);
      vscodeApi = api;
      window.__codexpatchVsCodeApi = api;
      setTimeout(() => {
        syncSettings();
        diag("boot");
      }, 0);
      return api;
    };
    window.__codexpatchAcquireWrapped = true;
  }

  function isVisible(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function labelOf(element) {
    return [
      element.textContent || "",
      element.getAttribute?.("aria-label") || "",
      element.getAttribute?.("title") || "",
      element.getAttribute?.("data-testid") || "",
      element.getAttribute?.("data-test-id") || ""
    ].join(" ").replace(/\\s+/g, " ").trim();
  }

  function normalizedLabel(element) {
    return labelOf(element).toLowerCase();
  }

  function buttonSignature(button) {
    return [normalizedLabel(button), location.pathname, location.hash].join("|");
  }

  function retryButtonScore(button) {
    const label = normalizedLabel(button);
    if (!label) return 0;
    if (label.length > 48) return 0;
    if (/^(retry|try again|重试|再试一次|重新尝试)$/.test(label)) return 100;
    if (label.length <= 32 && /(^|\\b)(retry|try again)(\\b|$)/.test(label)) return 80;
    if (label.length <= 16 && /重试|再试一次|重新尝试/.test(label)) return 80;
    return 0;
  }

  function findRetryButton() {
    const candidates = Array.from(document.querySelectorAll("button,[role='button']"));
    let best = null;
    let bestScore = 0;
    for (const button of candidates) {
      if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") continue;
      if (!isVisible(button)) continue;
      const score = retryButtonScore(button);
      if (score > bestScore) {
        best = button;
        bestScore = score;
      }
    }
    return best;
  }

  function maybeAutoRetry() {
    if (SETTINGS.autoRetry !== true) return;
    if (!isAutoRetryArmed()) return;
    const button = findRetryButton();
    if (!button) {
      lastRetrySignature = "";
      return;
    }
    const signature = buttonSignature(button);
    const now = Date.now();
    if (signature === lastRetrySignature && now - lastRetryClickAt < 10000) return;
    if (pendingRetryTimer) return;
    diag("auto-retry-found", { label: labelOf(button).slice(0, 120) });
    pendingRetryTimer = window.setTimeout(() => {
      pendingRetryTimer = null;
      if (!isAutoRetryArmed()) return;
      const latest = findRetryButton();
      if (!latest || buttonSignature(latest) !== signature) return;
      lastRetrySignature = signature;
      lastRetryClickAt = Date.now();
      autoRetryArmedUntil = 0;
      autoRetryArmId = "";
      diag("auto-retry-click", { label: labelOf(latest).slice(0, 120) });
      latest.click();
    }, SETTINGS.retryDelayMs);
  }

  function scheduleAutoRetryScan() {
    if (SETTINGS.autoRetry !== true || !isAutoRetryArmed()) return;
    if (retryScanQueued) return;
    retryScanQueued = true;
    window.setTimeout(() => {
      retryScanQueued = false;
      maybeAutoRetry();
    }, 250);
  }

  function boot() {
    if (window.__codexpatchBooted) return;
    window.__codexpatchBooted = true;
    wrapAcquireVsCodeApi();
    syncSettings();
    diag("boot");
    window.addEventListener("message", handleHostMessage);
    const observer = new MutationObserver(() => {
      if (isAutoRetryArmed()) scheduleAutoRetryScan();
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "aria-disabled", "aria-label", "title"] });
    window.setInterval(() => {
      if (isAutoRetryArmed()) scheduleAutoRetryScan();
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
`;

function buildInitialSettings(options) {
  return {
    notify: options.notify !== false,
    autoRetry: options.autoRetry !== false,
    retryDelayMs: 1500
  };
}

function buildNotificationHandler(options) {
  const settings = JSON.stringify(buildInitialSettings(options));
  return V10_NOTIFICATION_HANDLER.replace(
    "function cpText(e){",
    `globalThis.__codexpatchSettings=${settings};\nfunction cpText(e){`
  );
}

function buildWebviewUiSourceLite(options) {
  const settings = buildInitialSettings(options);
  const source = `const SETTINGS = { notify: ${settings.notify}, autoRetry: ${settings.autoRetry}, retryDelayMs: ${settings.retryDelayMs} };`;
  return WEBVIEW_UI_SOURCE_LITE.replace(
    "const SETTINGS = { notify: true, autoRetry: true, retryDelayMs: 1500 };",
    source
  );
}

const APP_MAIN_INTERRUPT_ANCHOR =
  '"interrupt-conversation":mM(async(e,{conversationId:t,initiatedBy:n},r)=>{let i=await e.interruptConversation(t);n===`user`&&i!=null&&r.markTurnInterruptedByThisClient(t,i)})';

const APP_MAIN_INTERRUPT_PATCH =
  '"interrupt-conversation":mM(async(e,{conversationId:t,initiatedBy:n},r)=>{n===`user`&&globalThis.__codexpatchPostUserInterrupt?.({conversationId:t,method:"interrupt-conversation",initiatedBy:n});let i=await e.interruptConversation(t);n===`user`&&i!=null&&(globalThis.__codexpatchPostUserInterrupt?.({conversationId:t,turnId:i,method:"interrupt-conversation",initiatedBy:n}),r.markTurnInterruptedByThisClient(t,i))})/* codexpatch:v1:webview-user-interrupt */';

const APP_MAIN_FOLLOWER_INTERRUPT_ANCHOR =
  '"thread-follower-interrupt-turn-for-host":$(async(e,t)=>(e.assertThreadFollowerOwner(t.conversationId),{interruptedTurnId:await e.interruptConversation(t.conversationId),ok:!0}))';

const APP_MAIN_FOLLOWER_INTERRUPT_PATCH =
  '"thread-follower-interrupt-turn-for-host":$(async(e,t)=>(e.assertThreadFollowerOwner(t.conversationId),globalThis.__codexpatchPostUserInterrupt?.({conversationId:t.conversationId,requestId:t.requestId,method:"thread-follower-interrupt-turn-for-host"}),{interruptedTurnId:await e.interruptConversation(t.conversationId),ok:!0}))/* codexpatch:v1:webview-user-interrupt */';

const APP_MAIN_CODEXPATCH_RETRY_COMMAND_ANCHOR =
  '"retry-safety-buffered-turn-for-host":$(async(e,{conversationId:t,turnId:n,model:r})=>{';

const APP_MAIN_CODEXPATCH_RETRY_COMMAND_PATCH =
  '"codexpatch-retry-turn-for-host":$(async(e,{conversationId:t,turnId:n,model:r})=>{/* codexpatch:v1:webview-auto-retry-command */let i=un(e.getConversation(t),n);if(i==null)throw Error(`Turn not found.`);if(i.status===`inProgress`&&await e.interruptConversation(t)!==i.turnId)throw Error(`The turn is no longer active.`);let a=e.getConversation(t);if(a==null)throw Error(`Conversation state not found.`);gM(e,{conversationId:t,conversationState:a,rollbackResponse:await e.sendRequest(`thread/rollback`,{threadId:t,numTurns:1})});let o=(0,fM.default)(i.params,[`clientUserMessageId`,`threadId`]),s=r??i.params?.model??o.model??a.latestModel??null;await hi(e,t,{...o,model:s,inheritThreadSettings:!1})}),"retry-safety-buffered-turn-for-host":$(async(e,{conversationId:t,turnId:n,model:r})=>{';

const APP_MAIN_AUTO_RETRY_ANCHOR =
  'case`ipc-broadcast`:e.method===`automation-capability-event`&&e.sourceClientId===`desktop`&&e.version===ze(`automation-capability-event`)&&QO(r,i.getForHostId(e.params.hostId),e.params),uk({claimAppConnectOAuthCallback:p,isCompactWindow:d,message:e,navigate:a,queryClient:c});break bb35;case`thread-follower-start-turn-request`:';

const APP_MAIN_AUTO_RETRY_PATCH =
  'case`codexpatch-auto-retry`:{/* codexpatch:v2:webview-auto-retry-send */try{let t=e.conversationId??e.threadId,n=t?(e.turnId||r.get(Nr,t)?.turnId):e.turnId,o=t?(e.model??r.get(Nr,t)?.params?.model??null):e.model;if(!t||!n){B.dispatchMessage(`codexpatch-diagnostic`,{event:`auto-retry-send-skip-missing-context`,conversationId:t||``,turnId:n||``});break bb35}B.dispatchMessage(`codexpatch-diagnostic`,{event:`auto-retry-send`,conversationId:t,turnId:n,model:o||``});await W(`codexpatch-retry-turn-for-host`,{hostId:e.hostId??zr,conversationId:t,turnId:n,model:o});B.dispatchMessage(`codexpatch-diagnostic`,{event:`auto-retry-send-ok`,conversationId:t,turnId:n})}catch(t){B.dispatchMessage(`codexpatch-diagnostic`,{event:`auto-retry-send-error`,conversationId:e.conversationId||e.threadId||``,message:String(t).slice(0,500)})}break bb35}case`ipc-broadcast`:e.method===`automation-capability-event`&&e.sourceClientId===`desktop`&&e.version===ze(`automation-capability-event`)&&QO(r,i.getForHostId(e.params.hostId),e.params),uk({claimAppConnectOAuthCallback:p,isCompactWindow:d,message:e,navigate:a,queryClient:c});break bb35;case`thread-follower-start-turn-request`:';

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "test-notify") {
    runNotificationTest();
    return;
  }

  const extensionDir = options.extensionDir
    ? path.resolve(options.extensionDir)
    : findLatestExtensionDir();
  const manifest = readManifest(extensionDir);
  const files = getTargetFiles(extensionDir);

  assertExtensionLooksRight(extensionDir, manifest, files);

  if (command === "check") {
    printStatus(extensionDir, manifest, files);
    return;
  }

  if (command === "apply") {
    try {
      applyPatch(extensionDir, manifest, files, options);
      assertPatchInstalled(manifest, files);
      cleanupLegacyBackups(files);
      cleanupOldExtensionState(extensionDir);
      if (options.notify !== false) showScriptNotification("vscodexkit 已安装", "检测通过，脚本正常工作。", "Info");
    } catch (error) {
      console.error("Apply/check failed. Restoring the original extension from the clean baseline.");
      console.error(error && error.stack ? error.stack : String(error));
      try {
        restorePatch(extensionDir, manifest, files, { uninstall: true, failedApply: true });
      } catch (restoreError) {
        console.error("Restore after failed apply also failed.");
        console.error(restoreError && restoreError.stack ? restoreError.stack : String(restoreError));
      }
      process.exitCode = 1;
    }
    return;
  }

  if (command === "restore" || command === "uninstall") {
    restorePatch(extensionDir, manifest, files, { uninstall: command === "uninstall" });
    return;
  }

  usage(`Unknown command: ${command}`);
}

function parseArgs(args) {
  let command = "check";
  const options = {
    extensionDir: null,
    skipSyntaxCheck: false,
    notify: true,
    autoRetry: true
  };

  if (args[0] && !args[0].startsWith("-")) {
    command = args.shift();
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--extension-dir") {
      const value = args[++i];
      if (!value) usage("--extension-dir requires a path");
      options.extensionDir = value;
    } else if (arg === "--no-backup") {
      // Kept as a no-op for older shortcuts; timestamped .bak files are no longer created.
    } else if (arg === "--skip-syntax-check") {
      options.skipSyntaxCheck = true;
    } else if (arg === "--notify") {
      options.notify = true;
    } else if (arg === "--no-notify") {
      options.notify = false;
    } else if (arg === "--auto-retry") {
      options.autoRetry = true;
    } else if (arg === "--no-auto-retry") {
      options.autoRetry = false;
    } else if (arg === "-h" || arg === "--help") {
      usage();
    } else {
      usage(`Unknown option: ${arg}`);
    }
  }

  return { command, options };
}

function usage(error) {
  if (error) {
    console.error(error);
    console.error("");
  }

  console.error(`vscodexkit ${VERSION}

Usage:
  node ./bin/vscodexkit.js check [--extension-dir <dir>]
  node ./bin/vscodexkit.js apply [--extension-dir <dir>] [--notify|--no-notify] [--auto-retry|--no-auto-retry] [--skip-syntax-check]
  node ./bin/vscodexkit.js restore [--extension-dir <dir>]
  node ./bin/vscodexkit.js uninstall [--extension-dir <dir>]
  node ./bin/vscodexkit.js test-notify

Notes:
  - Only the VSCode extension install directory is patched.
  - apply defaults to --notify --auto-retry.
  - A single clean baseline is kept under .codexpatch/original; timestamped .bak files are not created.
  - VSCode user data, globalStorage, workspaceStorage, and project files are not touched.
  - uninstall restores the clean baseline and removes vscodexkit state.
  - Reload VSCode after apply/restore/uninstall.`);
  process.exit(error ? 1 : 0);
}

function runNotificationTest() {
  if (process.platform !== "win32") {
    console.log("System notification test is Windows-only.");
    return;
  }
  const shortcutTarget = findVsCodeExecutable() || process.execPath;
  childProcess.execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Sta", "-Command", WINDOWS_SYSTEM_NOTIFY_PS_V7],
    {
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        CODEXPATCH_TITLE: "vscodexkit 测试",
        CODEXPATCH_BODY: "如果看到这条，系统通知通道可用。",
        CODEXPATCH_ICON: "Info",
        CODEXPATCH_AUMID: "vscodexkit.VSCode",
        CODEXPATCH_SHORTCUT_TARGET: shortcutTarget,
        CODEXPATCH_SHORTCUT_ICON: shortcutTarget
      }
    }
  );
  console.log("Notification test finished.");
}

function showScriptNotification(title, body, icon = "Info") {
  if (process.platform !== "win32") return;
  try {
    const shortcutTarget = findVsCodeExecutable() || process.execPath;
    const child = childProcess.spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Sta", "-Command", WINDOWS_SYSTEM_NOTIFY_PS_V7],
      {
        windowsHide: true,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          CODEXPATCH_TITLE: title,
          CODEXPATCH_BODY: body,
          CODEXPATCH_ICON: icon,
          CODEXPATCH_AUMID: "vscodexkit.VSCode",
          CODEXPATCH_SHORTCUT_TARGET: shortcutTarget,
          CODEXPATCH_SHORTCUT_ICON: shortcutTarget
        }
      }
    );
    child.unref?.();
  } catch (error) {
    console.warn(`System notification failed: ${error?.message || error}`);
  }
}

function findVsCodeExecutable() {
  const candidates = [
    process.env.VSCODE_EXECUTABLE_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe")
  ].filter(Boolean);

  const fromPath = findVsCodeExecutableFromPath();
  if (fromPath) candidates.unshift(fromPath);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function findVsCodeExecutableFromPath() {
  try {
    const output = childProcess.execFileSync("where.exe", ["code"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    for (const line of output.split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry) continue;
      if (/\\bin\\code\.cmd$/i.test(entry)) {
        const exe = path.resolve(path.dirname(entry), "..", "Code.exe");
        if (fs.existsSync(exe)) return exe;
      }
      if (/\\Code(?: - Insiders)?\.exe$/i.test(entry) && fs.existsSync(entry)) return entry;
    }
  } catch {}
  return null;
}

function getTargetFiles(extensionDir) {
  const webviewAppMain = findWebviewAssetByNeedle(
    extensionDir,
    APP_MAIN_INTERRUPT_ANCHOR,
    MARKERS.webviewUserInterrupt
  );
  const webviewAppMainRelativePath = webviewAppMain ? path.relative(extensionDir, webviewAppMain) : null;
  return {
    extensionJs: path.join(extensionDir, EXTENSION_JS),
    webviewIndex: path.join(extensionDir, WEBVIEW_INDEX),
    webviewUi: path.join(extensionDir, WEBVIEW_UI),
    webviewAppMain,
    webviewAppMainRelativePath,
    webviewAppMainMetaKey: webviewAppMainRelativePath ? normalizeRelativePath(webviewAppMainRelativePath) : null,
    baselineDir: path.join(extensionDir, BASELINE_DIR),
    baselineOriginalDir: path.join(extensionDir, BASELINE_ORIGINAL_DIR),
    baselineMeta: path.join(extensionDir, BASELINE_META),
    baselineExtensionJs: path.join(extensionDir, BASELINE_ORIGINAL_DIR, EXTENSION_JS),
    baselineWebviewIndex: path.join(extensionDir, BASELINE_ORIGINAL_DIR, WEBVIEW_INDEX),
    baselineWebviewUi: path.join(extensionDir, BASELINE_ORIGINAL_DIR, WEBVIEW_UI),
    baselineWebviewAppMain: webviewAppMainRelativePath
      ? path.join(extensionDir, BASELINE_ORIGINAL_DIR, webviewAppMainRelativePath)
      : null
  };
}

function normalizeRelativePath(relativePath) {
  return String(relativePath).split(path.sep).join("/");
}

function findWebviewAssetByNeedle(extensionDir, needle, marker) {
  const assetsDir = path.join(extensionDir, WEBVIEW_ASSETS_DIR);
  if (!fs.existsSync(assetsDir)) return null;
  const matches = [];
  for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const filePath = path.join(assetsDir, entry.name);
    let source = "";
    try {
      source = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (source.includes(needle) || source.includes(marker)) matches.push(filePath);
  }
  if (matches.length > 1) {
    throw new Error(`Found multiple candidate webview app bundles: ${matches.join(", ")}`);
  }
  return matches[0] || null;
}

function findLatestExtensionDir() {
  const userProfile = process.env.USERPROFILE || process.env.HOME;
  if (!userProfile) throw new Error("Cannot locate USERPROFILE/HOME. Use --extension-dir.");

  const extensionsRoot = path.join(userProfile, ".vscode", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    throw new Error(`VSCode extensions directory not found: ${extensionsRoot}`);
  }

  const candidates = fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(EXTENSION_DIR_PREFIX))
    .map((entry) => path.join(extensionsRoot, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, EXTENSION_JS)));

  if (candidates.length === 0) {
    throw new Error(`No ${EXTENSION_DIR_PREFIX} extension found under ${extensionsRoot}`);
  }

  candidates.sort(compareExtensionDirsDesc);
  return candidates[0];
}

function compareExtensionDirsDesc(left, right) {
  const leftManifest = safeReadManifest(left);
  const rightManifest = safeReadManifest(right);
  const byVersion = compareVersionDesc(leftManifest?.version || "", rightManifest?.version || "");
  if (byVersion !== 0) return byVersion;
  return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
}

function compareVersionDesc(left, right) {
  const leftParts = String(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (rightParts[i] || 0) - (leftParts[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function safeReadManifest(extensionDir) {
  try {
    return readManifest(extensionDir);
  } catch {
    return null;
  }
}

function readManifest(extensionDir) {
  return JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf8"));
}

function assertExtensionLooksRight(extensionDir, manifest, files) {
  if (manifest.publisher !== "openai" || manifest.name !== "chatgpt") {
    throw new Error(`Refusing to patch unexpected extension at ${extensionDir}: ${manifest.publisher}.${manifest.name}`);
  }
  if (!fs.existsSync(files.extensionJs)) throw new Error(`Extension bundle not found: ${files.extensionJs}`);
  if (!fs.existsSync(files.webviewIndex)) throw new Error(`Webview index not found: ${files.webviewIndex}`);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function sha256(source) {
  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

function isCleanSource(source) {
  return !source.includes("codexpatch:");
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return null;
  }
}

function writeTextEnsuringDir(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, "utf8");
}

function countOccurrences(text, needle) {
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

function getPatchStatus(files) {
  const extensionSource = readText(files.extensionJs);
  const indexSource = readText(files.webviewIndex);
  const uiExists = fs.existsSync(files.webviewUi);
  const uiSource = uiExists ? readText(files.webviewUi) : "";
  const appMainExists = Boolean(files.webviewAppMain && fs.existsSync(files.webviewAppMain));
  const appMainSource = appMainExists ? readText(files.webviewAppMain) : "";
  const baselineMeta = readJsonIfExists(files.baselineMeta);

  return {
    extensionSource,
    indexSource,
    uiSource,
    appMainSource,
    webviewAppMainExists: appMainExists,
    baselineAvailable:
      baselineMeta != null &&
      fs.existsSync(files.baselineExtensionJs) &&
      fs.existsSync(files.baselineWebviewIndex),
    baselineVersion: baselineMeta?.extensionVersion || null,
    notificationPatched: extensionSource.includes(MARKERS.notifyV10),
    notificationV10: extensionSource.includes(MARKERS.notifyV10),
    notificationV9: extensionSource.includes(MARKERS.notifyV9),
    notificationV8: extensionSource.includes(MARKERS.notifyV8),
    notificationV7: extensionSource.includes(MARKERS.notifyV7),
    notificationV1: extensionSource.includes(MARKERS.notifyV1),
    notificationV2: extensionSource.includes(MARKERS.notifyV2),
    notificationV3: extensionSource.includes(MARKERS.notifyV3),
    notificationV4: extensionSource.includes(MARKERS.notifyV4),
    notificationV5: extensionSource.includes(MARKERS.notifyV5),
    notificationV6: extensionSource.includes(MARKERS.notifyV6),
    notificationAnchorCount: countOccurrences(extensionSource, ORIGINAL_NOTIFICATION_ANCHOR),
    mcpLifecyclePatched: extensionSource.includes(MARKERS.mcpLifecycle),
    mcpLifecycleAnchorCount: countOccurrences(extensionSource, MCP_LIFECYCLE_ANCHOR),
    appServerRequestPatched: extensionSource.includes(MARKERS.appServerRequest),
    appServerRequestAnchorCount: countOccurrences(extensionSource, APP_SERVER_REQUEST_ANCHOR),
    threadStreamStatePatched: extensionSource.includes(MARKERS.threadStreamState),
    threadStreamStateAnchorCount: countOccurrences(extensionSource, THREAD_STREAM_STATE_ANCHOR),
    userInterruptPatched: extensionSource.includes(MARKERS.userInterrupt),
    userInterruptAnchorCount: countOccurrences(extensionSource, USER_INTERRUPT_ANCHOR),
    webviewUserInterruptPatched: appMainSource.includes(MARKERS.webviewUserInterrupt),
    webviewInterruptAnchorCount: countOccurrences(appMainSource, APP_MAIN_INTERRUPT_ANCHOR),
    webviewFollowerInterruptAnchorCount: countOccurrences(appMainSource, APP_MAIN_FOLLOWER_INTERRUPT_ANCHOR),
    webviewAutoRetryPatched: appMainSource.includes(MARKERS.webviewAutoRetry),
    webviewAutoRetryCommandPatched: appMainSource.includes(MARKERS.webviewAutoRetryCommand),
    webviewAutoRetryCommandAnchorCount: countOccurrences(appMainSource, APP_MAIN_CODEXPATCH_RETRY_COMMAND_ANCHOR),
    webviewAutoRetryAnchorCount: countOccurrences(appMainSource, APP_MAIN_AUTO_RETRY_ANCHOR),
    hostSettingsPatched: extensionSource.includes(MARKERS.hostSettings),
    hostSettingsV2: extensionSource.includes(MARKERS.hostSettingsV2),
    hostSettingsAnchorCount: countOccurrences(extensionSource, HOST_MESSAGE_ANCHOR),
    webviewIndexPatched: indexSource.includes(MARKERS.webviewIndex),
    webviewIndexAnchorCount: countOccurrences(indexSource, WEBVIEW_SCRIPT_ANCHOR),
    webviewUiExists: uiExists,
    webviewUiPatched: uiSource.includes(MARKERS.webviewUi),
    webviewUiV7: uiSource.includes(MARKERS.webviewUiV7),
    webviewUiV6: uiSource.includes(MARKERS.webviewUiV6),
    webviewUiV5: uiSource.includes(MARKERS.webviewUiV5),
    webviewUiV4: uiSource.includes(MARKERS.webviewUiV4),
    webviewUiV3: uiSource.includes(MARKERS.webviewUiV3),
    webviewUiV2: uiSource.includes(MARKERS.webviewUiV2)
  };
}

function loadBaseline(manifest, files) {
  const meta = readJsonIfExists(files.baselineMeta);
  if (!meta) return null;
  if (meta.publisher !== manifest.publisher || meta.name !== manifest.name) return null;
  if (meta.extensionVersion !== manifest.version) return null;
  if (!fs.existsSync(files.baselineExtensionJs) || !fs.existsSync(files.baselineWebviewIndex)) return null;

  const extensionSource = readText(files.baselineExtensionJs);
  const indexSource = readText(files.baselineWebviewIndex);
  if (!isCleanSource(extensionSource) || !isCleanSource(indexSource)) return null;
  if (!baselineHashMatches(meta, EXTENSION_JS, extensionSource)) return null;
  if (!baselineHashMatches(meta, WEBVIEW_INDEX, indexSource)) return null;

  const webviewUiExists = meta.webviewUiExists === true;
  const uiSource = webviewUiExists && fs.existsSync(files.baselineWebviewUi)
    ? readText(files.baselineWebviewUi)
    : "";
  if (webviewUiExists && !isCleanSource(uiSource)) return null;
  if (webviewUiExists && !baselineHashMatches(meta, WEBVIEW_UI, uiSource)) return null;

  const webviewAppMainExists = meta.webviewAppMainExists === true;
  if (
    webviewAppMainExists &&
    normalizeRelativePath(meta.webviewAppMainRelativePath || "") !== files.webviewAppMainMetaKey
  ) {
    return null;
  }
  const appMainSource =
    webviewAppMainExists && files.baselineWebviewAppMain && fs.existsSync(files.baselineWebviewAppMain)
      ? readText(files.baselineWebviewAppMain)
      : "";
  if (webviewAppMainExists && !isCleanSource(appMainSource)) return null;
  if (
    webviewAppMainExists &&
    files.webviewAppMainMetaKey &&
    !baselineHashMatches(meta, files.webviewAppMainMetaKey, appMainSource)
  ) {
    return null;
  }

  return { extensionSource, indexSource, uiSource, appMainSource, webviewUiExists, webviewAppMainExists, meta };
}

function ensureBaseline(extensionDir, manifest, files, status) {
  const loaded = loadBaseline(manifest, files);
  if (loaded) return ensureWebviewAppMainBaseline(loaded, files, status);

  const existingMeta = readJsonIfExists(files.baselineMeta);
  const hasBaselineState = fs.existsSync(files.baselineDir);
  const staleBaseline =
    existingMeta != null &&
    (existingMeta.publisher !== manifest.publisher ||
      existingMeta.name !== manifest.name ||
      existingMeta.extensionVersion !== manifest.version);
  const currentLooksClean =
    isCleanSource(status.extensionSource) &&
    isCleanSource(status.indexSource) &&
    (!status.webviewUiExists || isCleanSource(status.uiSource)) &&
    (!status.webviewAppMainExists || isCleanSource(status.appMainSource));

  if ((staleBaseline || hasBaselineState) && !currentLooksClean) {
    throw new Error(
      `Cannot rebuild clean baseline for ${manifest.publisher}.${manifest.name}@${manifest.version}: current files are already patched and the saved baseline is missing, invalid, or for another extension version. Reinstall/update the VSCode Codex extension, then run apply again.`
    );
  }
  if (staleBaseline || hasBaselineState) {
    removeBaseline(extensionDir, files);
    console.log(
      staleBaseline
        ? `Removed stale baseline for ${existingMeta.publisher}.${existingMeta.name}@${existingMeta.extensionVersion}`
        : "Removed invalid baseline state"
    );
  }

  const extensionSource = getCleanSourceForBaseline(files.extensionJs, status.extensionSource, "out/extension.js");
  const indexSource = getCleanSourceForBaseline(files.webviewIndex, status.indexSource, "webview/index.html");
  const uiClean = getOptionalCleanSourceForBaseline(files.webviewUi, status.uiSource);
  const appMainClean = getOptionalCleanSourceForBaseline(files.webviewAppMain, status.appMainSource);
  if (!appMainClean.exists) {
    throw new Error("Cannot locate a clean webview app-main bundle for user-interrupt patching.");
  }

  writeTextEnsuringDir(files.baselineExtensionJs, extensionSource);
  writeTextEnsuringDir(files.baselineWebviewIndex, indexSource);
  if (uiClean.exists) {
    writeTextEnsuringDir(files.baselineWebviewUi, uiClean.source);
  } else if (fs.existsSync(files.baselineWebviewUi)) {
    fs.unlinkSync(files.baselineWebviewUi);
  }
  writeTextEnsuringDir(files.baselineWebviewAppMain, appMainClean.source);

  const meta = {
    codexpatch: VERSION,
    publisher: manifest.publisher,
    name: manifest.name,
    extensionVersion: manifest.version,
    extensionDir,
    createdAt: new Date().toISOString(),
    files: {
      [EXTENSION_JS]: sha256(extensionSource),
      [WEBVIEW_INDEX]: sha256(indexSource),
      [WEBVIEW_UI]: uiClean.exists ? sha256(uiClean.source) : null,
      [files.webviewAppMainMetaKey]: sha256(appMainClean.source)
    },
    webviewUiExists: uiClean.exists,
    webviewAppMainExists: appMainClean.exists,
    webviewAppMainRelativePath: files.webviewAppMainMetaKey
  };
  writeTextEnsuringDir(files.baselineMeta, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`Baseline: ${files.baselineMeta}`);
  return {
    extensionSource,
    indexSource,
    uiSource: uiClean.source,
    appMainSource: appMainClean.source,
    webviewUiExists: uiClean.exists,
    webviewAppMainExists: appMainClean.exists,
    meta
  };
}

function ensureWebviewAppMainBaseline(loaded, files, status) {
  if (loaded.webviewAppMainExists) return loaded;
  const appMainClean = getOptionalCleanSourceForBaseline(files.webviewAppMain, status.appMainSource);
  if (!appMainClean.exists) {
    throw new Error("Cannot locate a clean webview app-main bundle for user-interrupt patching.");
  }
  writeTextEnsuringDir(files.baselineWebviewAppMain, appMainClean.source);
  const meta = {
    ...loaded.meta,
    codexpatch: VERSION,
    files: {
      ...(loaded.meta.files || {}),
      [files.webviewAppMainMetaKey]: sha256(appMainClean.source)
    },
    webviewAppMainExists: true,
    webviewAppMainRelativePath: files.webviewAppMainMetaKey
  };
  writeTextEnsuringDir(files.baselineMeta, `${JSON.stringify(meta, null, 2)}\n`);
  return {
    ...loaded,
    appMainSource: appMainClean.source,
    webviewAppMainExists: true,
    meta
  };
}

function baselineHashMatches(meta, fileKey, source) {
  const expected = meta.files?.[fileKey];
  return typeof expected !== "string" || expected === sha256(source);
}

function getCleanSourceForBaseline(filePath, currentSource, label) {
  if (isCleanSource(currentSource)) return currentSource;
  throw new Error(
    `Cannot establish clean baseline for ${label}. Current file is already patched and no clean baseline is available. Reinstall/update the VSCode Codex extension, then run apply again.`
  );
}

function getOptionalCleanSourceForBaseline(filePath, currentSource) {
  if (!filePath) return { exists: false, source: "" };
  if (fs.existsSync(filePath) && isCleanSource(currentSource)) {
    return { exists: true, source: currentSource };
  }
  return { exists: false, source: "" };
}

function isPatchStatusOk(status) {
  return (
    (status.notificationPatched ||
      status.notificationV9 ||
      status.notificationV8 ||
      status.notificationV7 ||
      status.notificationV6 ||
      status.notificationV5 ||
      status.notificationV4 ||
      status.notificationV3 ||
      status.notificationV2 ||
      status.notificationV1 ||
      status.notificationAnchorCount === 1) &&
    (status.mcpLifecyclePatched || status.mcpLifecycleAnchorCount === 1) &&
    (status.appServerRequestPatched || status.appServerRequestAnchorCount === 1) &&
    (status.threadStreamStatePatched || status.threadStreamStateAnchorCount === 1) &&
    (status.userInterruptPatched || status.userInterruptAnchorCount === 1) &&
    (status.webviewUserInterruptPatched ||
      (status.webviewInterruptAnchorCount === 1 && status.webviewFollowerInterruptAnchorCount === 1)) &&
    (status.webviewAutoRetryPatched || status.webviewAutoRetryAnchorCount === 1) &&
    (status.webviewAutoRetryCommandPatched || status.webviewAutoRetryCommandAnchorCount === 1) &&
    (status.hostSettingsPatched || status.hostSettingsV2 || status.hostSettingsAnchorCount === 1) &&
    (status.webviewIndexPatched || status.webviewIndexAnchorCount === 1)
  );
}

function assertPatchInstalled(manifest, files) {
  const baseline = loadBaseline(manifest, files);
  if (!baseline) {
    throw new Error("Install check failed: clean baseline is missing or does not match this extension version.");
  }
  const status = getPatchStatus(files);
  if (!isPatchStatusOk(status)) {
    throw new Error("Install check failed: patched extension shape is incomplete or unsupported.");
  }
  console.log("Install check: ok");
}

function printStatus(extensionDir, manifest, files) {
  const status = getPatchStatus(files);
  const baseline = loadBaseline(manifest, files);
  console.log(`vscodexkit: ${VERSION}`);
  console.log(`Extension:  ${manifest.publisher}.${manifest.name}@${manifest.version}`);
  console.log(`Path:       ${extensionDir}`);
  console.log(`Baseline:  ${baseline ? `yes (${baseline.meta.extensionVersion})` : status.baselineAvailable ? `no (stored ${status.baselineVersion})` : "no"}`);
  console.log(`Host patch: ${status.notificationPatched && status.hostSettingsPatched && status.appServerRequestPatched && status.threadStreamStatePatched && status.userInterruptPatched ? "yes" : "no"}`);
  console.log(`Webview:    ${status.webviewIndexPatched && status.webviewUiPatched && status.webviewUserInterruptPatched && status.webviewAutoRetryPatched && status.webviewAutoRetryCommandPatched ? "yes" : "no"}`);
  console.log(`V1 patch:   ${status.notificationV1 ? "yes" : "no"}`);
  console.log(`V2 patch:   ${status.notificationV2 ? "yes" : "no"}`);
  console.log(`V3 patch:   ${status.notificationV3 ? "yes" : "no"}`);
  console.log(`Notify v4:  ${status.notificationV4 ? "yes" : "no"}`);
  console.log(`Notify v5:  ${status.notificationV5 ? "yes" : "no"}`);
  console.log(`Notify v6:  ${status.notificationV6 ? "yes" : "no"}`);
  console.log(`Notify v7:  ${status.notificationV7 ? "yes" : "no"}`);
  console.log(`Notify v8:  ${status.notificationV8 ? "yes" : "no"}`);
  console.log(`Notify v9:  ${status.notificationV9 ? "yes" : "no"}`);
  console.log(`Notify v10: ${status.notificationV10 ? "yes" : "no"}`);
  console.log(`Lifecycle:  ${status.mcpLifecyclePatched ? "yes" : "no"}`);
  console.log(`App req:    ${status.appServerRequestPatched ? "yes" : "no"}`);
  console.log(`Stream:     ${status.threadStreamStatePatched ? "yes" : "no"}`);
  console.log(`Interrupt:  ${status.userInterruptPatched ? "yes" : "no"}`);
  console.log(`WV int:     ${status.webviewUserInterruptPatched ? "yes" : "no"}`);
  console.log(`WV retry:   ${status.webviewAutoRetryPatched ? "yes" : "no"}`);
  console.log(`WV retry cmd: ${status.webviewAutoRetryCommandPatched ? "yes" : "no"}`);
  console.log(`Host v2:    ${status.hostSettingsV2 ? "yes" : "no"}`);
  console.log(`Webview v8: ${status.webviewUiPatched ? "yes" : "no"}`);
  console.log(`Webview v7: ${status.webviewUiV7 ? "yes" : "no"}`);
  console.log(`Webview v6: ${status.webviewUiV6 ? "yes" : "no"}`);
  console.log(`Webview v5: ${status.webviewUiV5 ? "yes" : "no"}`);
  console.log(`Webview v4: ${status.webviewUiV4 ? "yes" : "no"}`);
  console.log(`Webview v3: ${status.webviewUiV3 ? "yes" : "no"}`);
  console.log(`Webview v2: ${status.webviewUiV2 ? "yes" : "no"}`);
  console.log(`Anchors:    notify=${status.notificationAnchorCount} lifecycle=${status.mcpLifecycleAnchorCount} appReq=${status.appServerRequestAnchorCount} stream=${status.threadStreamStateAnchorCount} interrupt=${status.userInterruptAnchorCount} host=${status.hostSettingsAnchorCount} webview=${status.webviewIndexAnchorCount} wvInt=${status.webviewInterruptAnchorCount}/${status.webviewFollowerInterruptAnchorCount} wvRetry=${status.webviewAutoRetryAnchorCount} wvRetryCmd=${status.webviewAutoRetryCommandAnchorCount}`);
  const legacyBackupCount = listAllBackups(files).length;
  if (legacyBackupCount > 0) {
    console.log(`Legacy .bak: ${legacyBackupCount} (removed on apply/uninstall)`);
  }

  const ok = isPatchStatusOk(status);
  console.log(`Status:     ${ok ? "ok" : "unsupported bundle shape; apply will fail closed"}`);
}

function applyPatch(extensionDir, manifest, files, options) {
  const status = getPatchStatus(files);
  const baseline = ensureBaseline(extensionDir, manifest, files, status);
  const notificationHandler = buildNotificationHandler(options);
  const webviewUiSource = buildWebviewUiSourceLite(options);

  const extensionSourceWithNotify = replaceExactlyOnce(
    baseline.extensionSource,
    ORIGINAL_NOTIFICATION_ANCHOR,
    notificationHandler,
    "notification anchor in clean baseline"
  );
  const extensionSourceWithHostSettings = replaceExactlyOnce(
    extensionSourceWithNotify,
    HOST_MESSAGE_ANCHOR,
    HOST_MESSAGE_PATCH,
    "host message anchor in clean baseline"
  );
  const extensionSourceWithAppServerRequest = replaceExactlyOnce(
    extensionSourceWithHostSettings,
    APP_SERVER_REQUEST_ANCHOR,
    APP_SERVER_REQUEST_PATCH,
    "app server request anchor in clean baseline"
  );
  const extensionSourceWithLifecycle = replaceExactlyOnce(
    extensionSourceWithAppServerRequest,
    MCP_LIFECYCLE_ANCHOR,
    MCP_LIFECYCLE_PATCH,
    "MCP lifecycle anchor in clean baseline"
  );
  const extensionSourceWithUserInterrupt = replaceExactlyOnce(
    extensionSourceWithLifecycle,
    USER_INTERRUPT_ANCHOR,
    USER_INTERRUPT_PATCH,
    "user interrupt anchor in clean baseline"
  );
  const extensionSource = replaceExactlyOnce(
    extensionSourceWithUserInterrupt,
    THREAD_STREAM_STATE_ANCHOR,
    THREAD_STREAM_STATE_PATCH,
    "thread stream state anchor in clean baseline"
  );
  const indexSource = replaceExactlyOnce(
    baseline.indexSource,
    WEBVIEW_SCRIPT_ANCHOR,
    WEBVIEW_SCRIPT_PATCH,
    "webview script anchor in clean baseline"
  );
  const appMainWithInterrupt = replaceExactlyOnce(
    baseline.appMainSource,
    APP_MAIN_INTERRUPT_ANCHOR,
    APP_MAIN_INTERRUPT_PATCH,
    "webview interrupt-conversation anchor in clean baseline"
  );
  const appMainWithFollowerInterrupt = replaceExactlyOnce(
    appMainWithInterrupt,
    APP_MAIN_FOLLOWER_INTERRUPT_ANCHOR,
    APP_MAIN_FOLLOWER_INTERRUPT_PATCH,
    "webview follower interrupt anchor in clean baseline"
  );
  const appMainWithAutoRetryCommand = replaceExactlyOnce(
    appMainWithFollowerInterrupt,
    APP_MAIN_CODEXPATCH_RETRY_COMMAND_ANCHOR,
    APP_MAIN_CODEXPATCH_RETRY_COMMAND_PATCH,
    "webview auto retry command anchor in clean baseline"
  );
  const appMainSource = replaceExactlyOnce(
    appMainWithAutoRetryCommand,
    APP_MAIN_AUTO_RETRY_ANCHOR,
    APP_MAIN_AUTO_RETRY_PATCH,
    "webview auto retry message anchor in clean baseline"
  );

  if (
    status.extensionSource === extensionSource &&
    status.indexSource === indexSource &&
    status.uiSource === webviewUiSource &&
    status.appMainSource === appMainSource
  ) {
    console.log(`Already patched from clean baseline: ${extensionDir}`);
    return;
  }

  writeTextEnsuringDir(files.extensionJs, extensionSource);
  writeTextEnsuringDir(files.webviewIndex, indexSource);
  writeTextEnsuringDir(files.webviewUi, webviewUiSource);
  writeTextEnsuringDir(files.webviewAppMain, appMainSource);

  if (!options.skipSyntaxCheck) {
    try {
      childProcess.execFileSync(process.execPath, ["--check", files.extensionJs], {
        stdio: "pipe",
        windowsHide: true
      });
      childProcess.execFileSync(process.execPath, ["--check", files.webviewUi], {
        stdio: "pipe",
        windowsHide: true
      });
      childProcess.execFileSync(process.execPath, ["--check", files.webviewAppMain], {
        stdio: "pipe",
        windowsHide: true
      });
    } catch (error) {
      console.error("Syntax check failed after patch. Restoring the clean baseline.");
      restoreFilesFromBaseline(baseline, files);
      throw error;
    }
  }

  console.log(`Patched: ${manifest.publisher}.${manifest.name}@${manifest.version}`);
  console.log("Reload VSCode to load the patched extension.");
}

function replaceExactlyOnce(source, needle, replacement, label) {
  const count = countOccurrences(source, needle);
  if (count !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${count}.`);
  }
  return source.replace(needle, replacement);
}

function restorePatch(extensionDir, manifest, files, options = {}) {
  const baseline = loadBaseline(manifest, files);
  if (baseline) {
    const restored = restoreFilesFromBaseline(baseline, files);
    if (options.uninstall) {
      removeNotificationShortcuts();
      removeBaseline(extensionDir, files);
    }
    cleanupLegacyBackups(files);

    const action = options.uninstall ? "Uninstalled" : "Restored from clean baseline";
    console.log(`${action}: ${manifest.publisher}.${manifest.name}@${manifest.version}`);
    for (const entry of restored) {
      console.log(`- ${entry.filePath} <= ${entry.backup}`);
    }
    console.log("Reload VSCode to load the restored extension.");
    return;
  }

  cleanupLegacyBackups(files);
  if (options.uninstall && isCurrentInstallClean(files)) {
    removeNotificationShortcuts();
    removeBaseline(extensionDir, files);
    console.log(`Uninstalled: no matching baseline was present and the extension is already clean.`);
    return;
  }

  console.log(`No matching clean baseline found: ${extensionDir}`);
  console.log("Reinstalling/updating the VSCode extension is the clean fallback.");
}

function restoreFilesFromBaseline(baseline, files) {
  const restored = [];
  writeTextEnsuringDir(files.extensionJs, baseline.extensionSource);
  restored.push({ filePath: files.extensionJs, backup: files.baselineExtensionJs });
  writeTextEnsuringDir(files.webviewIndex, baseline.indexSource);
  restored.push({ filePath: files.webviewIndex, backup: files.baselineWebviewIndex });

  if (baseline.webviewUiExists) {
    writeTextEnsuringDir(files.webviewUi, baseline.uiSource);
    restored.push({ filePath: files.webviewUi, backup: files.baselineWebviewUi });
  } else if (fs.existsSync(files.webviewUi)) {
    const uiSource = readText(files.webviewUi);
    if (uiSource.includes("codexpatch:")) {
      fs.unlinkSync(files.webviewUi);
      restored.push({ filePath: files.webviewUi, backup: "(deleted generated file)" });
    }
  }
  if (baseline.webviewAppMainExists) {
    writeTextEnsuringDir(files.webviewAppMain, baseline.appMainSource);
    restored.push({ filePath: files.webviewAppMain, backup: files.baselineWebviewAppMain });
  }
  return restored;
}

function isCurrentInstallClean(files) {
  try {
    const status = getPatchStatus(files);
    return (
      isCleanSource(status.extensionSource) &&
      isCleanSource(status.indexSource) &&
      (!status.webviewUiExists || isCleanSource(status.uiSource)) &&
      (!status.webviewAppMainExists || isCleanSource(status.appMainSource))
    );
  } catch {
    return false;
  }
}

function removeBaseline(extensionDir, files) {
  const extensionRoot = path.resolve(extensionDir);
  const target = path.resolve(files.baselineDir);
  if (!isPathInside(extensionRoot, target) || path.basename(target) !== BASELINE_DIR) {
    throw new Error(`Refusing to remove unexpected baseline path: ${target}`);
  }
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`Removed baseline: ${target}`);
  }
}

function removeNotificationShortcuts() {
  if (process.platform !== "win32") return;
  const appData = process.env.APPDATA;
  if (!appData) return;
  const programs = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs");
  const targets = ["vscodexkit.lnk"].map((name) => path.join(programs, name));
  for (const target of targets) {
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        console.log(`Removed notification shortcut: ${target}`);
      }
    } catch (error) {
      console.warn(`Failed to remove notification shortcut ${target}: ${error?.message || error}`);
    }
  }
}

function cleanupOldExtensionState(currentExtensionDir) {
  const current = path.resolve(currentExtensionDir);
  const extensionsRoot = path.resolve(path.dirname(current));
  if (!fs.existsSync(extensionsRoot)) return;

  for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(EXTENSION_DIR_PREFIX)) continue;
    const extensionDir = path.resolve(extensionsRoot, entry.name);
    if (extensionDir === current) continue;
    if (!isPathInside(extensionsRoot, extensionDir)) continue;
    const baselineDir = path.resolve(extensionDir, BASELINE_DIR);
    if (!isPathInside(extensionDir, baselineDir) || path.basename(baselineDir) !== BASELINE_DIR) continue;
    if (fs.existsSync(baselineDir)) {
      fs.rmSync(baselineDir, { recursive: true, force: true });
      console.log(`Removed old extension baseline: ${baselineDir}`);
    }
  }
}

function cleanupLegacyBackups(files) {
  for (const backup of listAllBackups(files)) {
    if (!backup.endsWith(".bak") || !path.basename(backup).includes(".codexpatch.")) continue;
    try {
      fs.unlinkSync(backup);
      console.log(`Removed legacy backup: ${backup}`);
    } catch (error) {
      console.warn(`Failed to remove legacy backup ${backup}: ${error?.message || error}`);
    }
  }
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function listAllBackups(files) {
  return [
    ...listBackups(files.extensionJs),
    ...listBackups(files.webviewIndex),
    ...listBackups(files.webviewUi),
    ...listBackups(files.webviewAppMain)
  ];
}

function listBackups(filePath) {
  if (!filePath) return [];
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) return [];
  const base = path.basename(filePath);
  const prefix = `${base}.codexpatch.`;
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
    .map((name) => path.join(dir, name))
    .sort();
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
