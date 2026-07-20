#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const crypto = require("crypto");
const {
  RETRY_HANDLER_KEY,
  inspectWebviewRetryPlan,
  resolveWebviewRetryPlan
} = require("../lib/webview-symbol-resolver");

function parseAdbDeviceSerials(output) {
  const serials = [];
  const seen = new Set();
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+device(?:\s|$)/);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    serials.push(match[1]);
  }
  return serials;
}

function buildAdbNotificationArgs(title, body, event) {
  function encode(value, maxLength) {
    const normalized = String(value == null ? "" : value)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return Buffer.from(Array.from(normalized).slice(0, maxLength).join(""), "utf8").toString(
      "base64"
    );
  }

  const encodedTitle = encode(title, 80);
  const encodedBody = encode(body, 400);
  const tag =
    String(event == null ? "notify" : event)
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "notify";
  const script =
    "title=$(printf %s " +
    encodedTitle +
    "|base64 -d);body=$(printf %s " +
    encodedBody +
    '|base64 -d);cmd notification post -S bigtext -t "$title" vscodexkit-' +
    tag +
    ' "$body"';
  return ["shell", "sh", "-c", script];
}

const VERSION = "0.8.27";
const EXTENSION_DIR_PREFIX = "openai.chatgpt-";
const EXTENSION_JS = path.join("out", "extension.js");
const WEBVIEW_INDEX = path.join("webview", "index.html");
const WEBVIEW_UI = path.join("webview", "assets", "codexpatch-ui.js");
const WEBVIEW_ASSETS_DIR = path.join("webview", "assets");
const WEBVIEW_APP_MAIN_NEEDLES = [
  '"interrupt-conversation"',
  '"thread-follower-interrupt-turn-for-host"',
  '"retry-safety-buffered-turn-for-host"',
  "case`thread-follower-start-turn-request`:"
];
const BASELINE_DIR = ".codexpatch";
const BASELINE_ORIGINAL_DIR = path.join(BASELINE_DIR, "original");
const BASELINE_META = path.join(BASELINE_DIR, "baseline.json");

const MARKERS = {
  notifyV10: "codexpatch:v21:retry-message-reuse",
  mcpLifecycle: "codexpatch:v1:mcp-lifecycle-conversation-end",
  appServerRequest: "codexpatch:v2:app-server-request-approval",
  threadStreamState: "codexpatch:v2:thread-stream-state-conversation-end",
  userInterrupt: "codexpatch:v1:user-interrupt-suppress",
  webviewUserInterrupt: "codexpatch:v2:webview-user-interrupt",
  webviewAutoRetry: "codexpatch:v7:webview-auto-retry-message-reuse",
  webviewAutoRetryCommand: "codexpatch:v4:webview-auto-retry-message-command",
  hostSettings: "codexpatch:v3:host-settings",
  webviewIndex: "codexpatch:v2:webview-index",
  webviewUi: "codexpatch:v8:webview-ui-diagnostic-lite"
};

const ORIGINAL_NOTIFICATION_PATTERN =
  /([A-Za-z_$][\w$]*)\.push\(([A-Za-z_$][\w$]*)\.registerInternalNotificationHandler\(([A-Za-z_$][\w$]*)=>\{\3\.method==="turn\/completed"&&([A-Za-z_$][\w$]*)\.emit\("turnComplete"\)\}\)\);/;

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



const V10_NOTIFICATION_HANDLER = `e.push((()=>{/* ${MARKERS.notifyV10} */
function cpText(e){return e==null?"":typeof e==="string"?e:typeof e==="number"||typeof e==="boolean"?String(e):""}
function cpJson(e){try{return JSON.stringify(e,(r,n)=>typeof n==="string"&&n.length>240?n.slice(0,240)+"...":n)}catch(_){return""}}
function cpMod(){try{return{fs:require("fs"),os:require("os"),path:require("path"),cp:require("child_process")}}catch(_){return null}}
function cpLog(e,r){try{let n=cpMod();if(!n)return;let o=process.env.CODEXPATCH_LOG_FILE||n.path.join(n.os.tmpdir(),"codexpatch.log"),i=cpJson(r);n.fs.appendFileSync(o,new Date().toISOString()+" [host] "+e+(i?" "+i:"")+"\\n","utf8")}catch(_){}}
${parseAdbDeviceSerials.toString()}
${buildAdbNotificationArgs.toString()}
function cpAdbPath(e){try{let r=globalThis.__codexpatchAdbPath;if(r)return r;let n=process.platform==="win32"?"adb.exe":"adb",o=[process.env.CODEXPATCH_ADB_PATH,process.env.ANDROID_HOME&&e.path.join(process.env.ANDROID_HOME,"platform-tools",n),process.env.ANDROID_SDK_ROOT&&e.path.join(process.env.ANDROID_SDK_ROOT,"platform-tools",n),process.env.LOCALAPPDATA&&e.path.join(process.env.LOCALAPPDATA,"Android","Sdk","platform-tools",n)];for(let n of o)if(n&&e.fs.existsSync(n))return globalThis.__codexpatchAdbPath=n;return globalThis.__codexpatchAdbPath=n}catch(_){return"adb"}}
function cpNotifyAdb(e,r,n){try{let o=Date.now();if(o<(globalThis.__codexpatchAdbBackoffUntil||0))return;let i=cpMod();if(!i)return;let s=cpAdbPath(i);i.cp.execFile(s,["devices"],{windowsHide:true,timeout:4e3,encoding:"utf8",maxBuffer:65536},(o,a,c)=>{if(o){globalThis.__codexpatchAdbBackoffUntil=Date.now()+6e4;cpLog("adb-notify-list-error",{message:cpErr(o)||String(c||"").slice(0,300)});return}let l=parseAdbDeviceSerials(a);if(!l.length){let e=Date.now(),r=globalThis.__codexpatchAdbNoDevicesLogAt||0;if(e-r>3e5)globalThis.__codexpatchAdbNoDevicesLogAt=e,cpLog("adb-notify-skip-no-devices",{});return}for(let o of l)try{let a=["-s",o,...buildAdbNotificationArgs(e,r,n)],c="",l=i.cp.spawn(s,a,{windowsHide:true,stdio:["ignore","ignore","pipe"]});l.stderr?.on?.("data",e=>{c.length<500&&(c+=String(e).slice(0,500-c.length))});l.on?.("error",e=>cpLog("adb-notify-device-error",{serial:o,message:cpErr(e)}));l.on?.("exit",e=>cpLog(e===0?"adb-notify-device-ok":"adb-notify-device-failed",{serial:o,code:e,stderr:c.slice(0,500)}))}catch(e){cpLog("adb-notify-device-exception",{serial:o,message:cpErr(e)})}})}catch(e){cpLog("adb-notify-exception",{message:cpErr(e)})}}
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
function cpAssistantText(e){return cpText(e?.content)||cpText(e?.text)||cpText(e?.message)||cpText(e?.output)||cpText(e?.summary)}
function cpItemIndexOf(e){let r=cpPath(e),n=r.findIndex(e=>e==="items");return n>=0&&/^\\d+$/.test(cpText(r[n+1]))?Number(r[n+1]):-1}
function cpLooksUserItem(e){let r=cpText(e?.type).toLowerCase(),n=cpText(e?.role).toLowerCase();return n==="user"||r==="usermessage"||r==="user_message"||r==="user-message"}
function cpLooksErrorItem(e){let r=cpText(e?.type).toLowerCase(),n=cpText(e?.role).toLowerCase(),o=cpText(e?.status).toLowerCase();return n==="error"||/error|failure|failed|warning|notification|retry/.test(r)||o==="failed"&&r&&!/assistant|tool|command|exec|terminal/.test(r)}
function cpLooksOutputItem(e){if(e==null||typeof e!=="object"||Array.isArray(e))return false;if(cpLooksUserItem(e)||cpLooksErrorItem(e))return false;let r=cpText(e.type).toLowerCase(),n=cpText(e.role).toLowerCase(),o=cpAssistantText(e).trim();if(!o)return false;return n==="assistant"||/assistant|agent|reasoning|tool|command|exec|terminal|patch|diff|file|browser|image|plan|todo|thinking/.test(r)}
function cpObjHasAssistantOutput(e,r=0,n=false){if(r>8||e==null)return false;if(typeof e==="string")return n&&e.trim().length>0;if(Array.isArray(e))return e.some(e=>cpObjHasAssistantOutput(e,r+1,n));if(typeof e!=="object")return false;if(cpLooksUserItem(e)||cpLooksErrorItem(e))return false;if(cpLooksOutputItem(e))return true;let o=cpText(e.type).toLowerCase(),i=cpText(e.role).toLowerCase(),s=n||i==="assistant"||/assistant|agent|reasoning|tool|command|exec|terminal|patch|diff|file|browser|image|plan|todo|thinking/.test(o),a=cpAssistantText(e).trim();if(s&&a)return true;if(Array.isArray(e.items)&&e.items.some(e=>cpObjHasAssistantOutput(e,r+1,false)))return true;for(let n of["item","value","delta","message","entry","turn","payload"])if(cpObjHasAssistantOutput(e[n],r+1,s))return true;if(Array.isArray(e.content)&&e.content.some(e=>cpObjHasAssistantOutput(e,r+1,s)))return true;return false}
function cpOutputMap(){return globalThis.__codexpatchAssistantOutputByConversation||(globalThis.__codexpatchAssistantOutputByConversation=new Map)}
function cpTurnPathOf(e){let r=cpPath(e),n=r.findIndex(e=>e==="turns"||e==="conversationTurns"||e==="visibleTurnEntries");return n>=0&&r[n+1]!=null?r.slice(n,n+2).join("."):""}
function cpPathLooksAssistantOutput(e,r){return cpObjHasAssistantOutput(r)}
function cpRememberTurnPatch(e,r,n){try{let o=cpConv(e);if(!o||o==="global")return;let i=Date.now(),s=cpOutputMap();for(let[e,r]of s)try{i-r.at>6e5&&s.delete(e)}catch(_){}let a=cpTurnPathOf(r),c=cpFindStatus(n,0),l=cpText(n?.turnId)||cpText(n?.id),u=s.get(o)||{hasOutput:false,at:i};if(a&&u.turnPath&&u.turnPath!==a)u={hasOutput:false,at:i};if(!a&&c==="inProgress"&&l&&u.turnId&&u.turnId!==l&&!u.turnPath)u={hasOutput:false,at:i};if(a)u.turnPath=a;else if(l&&!u.turnId)u.turnId=l;if(cpPathLooksAssistantOutput(r,n)||cpObjHasAssistantOutput(n))u.hasOutput=true;u.at=i;s.set(o,u);if(u.hasOutput)cpLog("auto-retry-output-seen",{conversationId:o,turnId:u.turnId||"",turnPath:u.turnPath||"",itemIndex:cpItemIndexOf(r)})}catch(r){cpLog("auto-retry-output-track-exception",{message:r?.message})}}
function cpRememberAssistantOutput(e){try{let r=e?.change||e?.params?.change||{};if(r.type==="snapshot"){let n=r.conversationState?.turns||r.conversationState?.conversationTurns||r.conversationState?.visibleTurnEntries;if(Array.isArray(n))for(let r=n.length-1;r>=0;r--){if(cpFindStatus(n[r],0)==="inProgress"){cpRememberTurnPatch(e,["turns",r],n[r]);break}}return}if(Array.isArray(r.patches)){for(let n of r.patches){if(cpPathLooksTurn(n?.path))cpRememberTurnPatch(e,n.path,n?.value)}return}cpRememberTurnPatch(e,[],r)}catch(r){cpLog("auto-retry-output-observe-exception",{message:r?.message})}}
function cpAssistantOutputStateForRetry(e){try{let r=e?.params?.turn||e?.turn;if(r&&typeof r==="object")return cpObjHasAssistantOutput(r)?"present":"absent";let n=cpConv(e),o=cpTurnId(e),i=cpOutputMap().get(n);if(!i)return"unknown";if(o&&i.turnId&&o!==i.turnId)return"unknown";return i.hasOutput?"present":"absent"}catch(_){return"unknown"}}
function cpRetryRounds(){return globalThis.__codexpatchRetryRounds||(globalThis.__codexpatchRetryRounds=new Map)}
function cpRetryRound(e){let r=cpConv(e);return r&&r!=="global"?cpRetryRounds().get(r):null}
function cpArmRetryRound(e){let r=cpConv(e),n=Date.now(),o=cpRetryRounds(),i=o.get(r),s=i||{notified:false,startedAt:n};return s.awaitingRestart=true,s.messageRetry=e?.mode==="message"||e?.mode==="edit-message",s.at=n,o.set(r,s),s}
function cpRestartRetryRound(e){try{let r=cpConv(e),n=cpRetryRounds().get(r),o=cpTurnId(e);if(n?.awaitingRestart)n.awaitingRestart=false,n.messageRetry&&o&&(n.messageTurnId=o),n.at=Date.now(),cpLog("auto-retry-restart-observed",{conversationId:r,turnId:o,messageRetry:n.messageRetry===true})}catch(_){}}
function cpClearRetryRound(e,r){try{let n=cpConv(e);cpRetryRounds().delete(n);cpLog("auto-retry-round-end",{conversationId:n,reason:r})}catch(_){}}
function cpRetryBlob(e){let r=e?.params||{},n=[e?.source,e?.method,cpStatus(e),cpMsg(e),e?.error?.code,r.error?.code,r.turn?.error?.code,r.reason,r.details,r.errorMessage,cpJson(e?.error),cpJson(e?.change),cpJson(r.change),cpJson(r.error),cpJson(r.turn?.error),cpJson(r.payload?.error),cpJson(r.event?.error)].join(" ");return n.slice(0,12e3).toLowerCase()}
function cpLooksStreamRetryExhausted(e){let r=cpRetryBlob(e),n=(cpText(e?.source)+" "+cpText(e?.method)).toLowerCase(),o=/stream_error|thread-stream-state/.test(n)||/\\bstream\\b|stream[_ -]?/.test(r),i=cpStatus(e)==="failed"&&/(currently experiencing high demand|temporary errors?|temporarily unavailable|service unavailable|overloaded|too many requests|rate limit|\\b429\\b|\\b502\\b|\\b503\\b|\\b504\\b|gateway timeout|network error|fetch failed|failed to fetch|request failed|error sending request|stream disconnected|connection (?:reset|refused|closed|terminated)|econnreset|etimedout|eai_again|enotfound|timed?\\s*out)/.test(r);if(/stream[_ -]?max[_ -]?retries/.test(r))return true;if(i)return true;if(!o)return false;return /max(?:imum)?\\s+retries|retry limit|retries exhausted|exhausted\\s+retries|too many retries|retry attempts? exhausted|all retries failed|stream disconnected|error sending request/.test(r)}
function cpRequestAutoRetry(e){try{let r=globalThis.__codexpatchSettings||{};if(r.autoRetry!==true){cpLog("auto-retry-skip-disabled",{conversationId:cpConv(e),status:cpStatus(e),method:e?.method});return false}if(cpLooksUserInterrupted(e)){cpLog("auto-retry-skip-user-interrupt",{conversationId:cpConv(e),status:cpStatus(e),method:e?.method});return false}if(!cpLooksStreamRetryExhausted(e)){cpLog("auto-retry-skip-not-stream-max-retries",{conversationId:cpConv(e),status:cpStatus(e),method:e?.method,msg:cpMsg(e)});return false}let n=cpAssistantOutputStateForRetry(e);if(n==="unknown"){cpLog("auto-retry-skip-output-boundary",{conversationId:cpConv(e),outputState:n,status:cpStatus(e),method:e?.method});return false}let o=cpConv(e),i=cpTurnId(e)||cpOutputMap().get(o)?.turnId||"",s=cpRetryRound(e),a=n==="absent"?"rollback":s?.messageRetry&&s.messageTurnId&&s.messageTurnId===i?"edit-message":"message";if(a==="message"&&s?.messageRetry){cpLog("auto-retry-skip-message-turn-mismatch",{conversationId:o,turnId:i,expectedTurnId:s.messageTurnId||""});return false}let c=cpHost(e),l=cpModel(e),u=o+"|"+(i||cpRequestId(e)||cpMsg(e).slice(0,80))+"|"+cpStatus(e)+"|"+(e?.method||"")+"|"+a,f=Date.now(),p=globalThis.__codexpatchAutoRetryLast||(globalThis.__codexpatchAutoRetryLast=new Map),h=p.get(u);if(h&&f-h<3e4){cpLog("auto-retry-skip-duplicate",{key:u,mode:a});return true}for(let[e,r]of p)try{f-r>12e4&&p.delete(e)}catch(_){}let g={type:"codexpatch-auto-retry",hostId:c,conversationId:o,threadId:o,turnId:i,model:l||null,status:cpStatus(e),method:e?.method||"",reason:"stream_max_retries",mode:a,allowMessageRetry:a!=="rollback",hadTrackedOutput:n==="present",outputState:n,windowMs:3e4,at:f},m=globalThis.__codexpatchBroadcastToWebview;if(typeof m==="function"){let e=cpArmRetryRound(g);cpLog("auto-retry-arm",g);m(g);p.set(u,f);if(!e.notified)e.notified=true,cpNotify({source:"auto-retry",method:"codexpatch/auto-retry",conversationId:o,threadId:o,turnId:i,status:"retrying",kind:"retry",message:"Codex 正在自动重试",params:g});else cpLog("auto-retry-notify-skip-round",{conversationId:o});return true}else cpLog("auto-retry-no-broadcast",g);return false}catch(r){cpLog("auto-retry-exception",{message:r?.message});return false}}
function cpBody(e,r,n,o){if(o==="retry")return n||"Codex 正在自动重试";if(o==="approval"||cpApproval(e)||cpAwaitingUserMethod(r)){if(cpAwaitingInputMethod(r))return n||"Codex 需要你回复问题";return n||"Codex 需要你审批操作"}if(e==="completed")return"Codex 任务已完成";let i=r==="codex/event/stream_error"?"Codex 网络错误，任务已停止":r==="codex/event/error"?"Codex 任务发生错误":e==="interrupted"?"Codex 任务已中断":e==="failed"?"Codex 任务失败":"Codex 任务结束: "+(e??"unknown");return n?i+": "+String(n).slice(0,180):i}
function cpNotify(e){try{let r=globalThis.__codexpatchSettings||{};if(r.notify===false){cpLog("notify-skip-disabled",e);return}let n=cpStatus(e),o=e?.kind||"",i=e?.method||"",s=cpApproval(n)||o==="approval"||cpAwaitingUserMethod(i),v=o==="retry";if(!s&&!v&&!cpFinal(n)){cpLog("notify-skip-not-final",{status:n,kind:o,method:i});return}if(!s&&!v&&cpLooksUserInterrupted(e)){cpLog("notify-skip-user-interrupt",{status:n,method:i,msg:cpMsg(e)});return}let a=Date.now(),c=globalThis.__codexpatchNotifyLastByConversation||(globalThis.__codexpatchNotifyLastByConversation=new Map),l=cpConv(e),u=s?"approval":v?"retry":n,d=l+"|"+u+"|"+i+"|"+cpRequestId(e),f=c.get(d);if(f&&a-f<1e4){cpLog("notify-skip-duplicate",{key:d,status:n,kind:o});return}for(let[e,r]of c)try{a-r>12e4&&c.delete(e)}catch(_){}c.set(d,a);let p=cpMsg(e),h=s?"Codex 需要处理":"Codex",g=cpBody(n,i,p,o),m=s||n!=="completed";cpLog("notify-send",{conversationId:l,status:n,kind:o,method:i,body:g});cpNotifyAdb(h,g,u);if(process.platform==="win32")try{let e=${JSON.stringify(WINDOWS_SYSTEM_NOTIFY_PS_V8)},r=cpMod(),o=r.path.join(r.os.tmpdir(),"codexpatch-notify.ps1");try{r.fs.writeFileSync(o,e,"utf8");cpLog("notify-script-written",{path:o,bytes:e.length})}catch(e){cpLog("notify-script-write-failed",{message:e?.message})}let n=r.cp.spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-Sta","-File",o],{windowsHide:true,detached:false,stdio:["ignore","ignore","pipe"],env:{...process.env,CODEXPATCH_TITLE:h,CODEXPATCH_BODY:g,CODEXPATCH_ICON:m?"Warning":"Info",CODEXPATCH_EVENT:u,CODEXPATCH_AUMID:"vscodexkit.VSCode",CODEXPATCH_LOG_FILE:process.env.CODEXPATCH_LOG_FILE||r.path.join(r.os.tmpdir(),"codexpatch.log"),CODEXPATCH_SHORTCUT_TARGET:process.execPath,CODEXPATCH_SHORTCUT_ICON:process.execPath}});cpLog("notify-spawned",{pid:n.pid,event:u,file:o});n.stderr?.on?.("data",e=>cpLog("notify-stderr",{message:String(e).slice(0,500)}));n.on?.("exit",(e,r)=>cpLog("notify-exit",{code:e,signal:r,event:u}));n.on?.("error",e=>cpLog("notify-spawn-error",{message:e?.message}));return}catch(e){cpLog("notify-spawn-exception",{message:e?.message})}m?ut.window.showWarningMessage(g):ut.window.showInformationMessage(g)}catch(e){cpLog("notify-exception",{message:e?.message})}}
function cpStart(e){try{let r=cpConv(typeof e==="string"?{conversationId:e}:e);(globalThis.__codexpatchActiveConversations||(globalThis.__codexpatchActiveConversations=new Set)).add(r);if(typeof e==="string")try{cpOutputMap().delete(r)}catch(_){}else cpRestartRetryRound(e);cpLog("conversation-start",{conversationId:r,source:e?.source,method:e?.method})}catch(_){}}
function cpHandle(e){try{let r=cpStatus(e),n=e?.method||"";cpLog("observe",{source:e?.source,method:n,status:r,conversationId:cpConv(e),kind:e?.kind});if(r==="inProgress"){cpStart(e);return}if(cpFinal(r)&&!cpAuthoritativeEnd(e)){cpLog("notify-skip-nonauthoritative-final",{source:e?.source,method:n,status:r,conversationId:cpConv(e)});return}if(r==="completed"&&cpRetryRound(e)?.awaitingRestart){cpLog("notify-skip-stale-completed-during-retry",{conversationId:cpConv(e),method:n});return}let o=false;if(r==="failed"||n==="codex/event/stream_error"||n==="codex/event/error")o=cpRequestAutoRetry(e);if(o){cpLog("notify-skip-auto-retry",{conversationId:cpConv(e),status:r,method:n,msg:cpMsg(e)});return}if(cpFinal(r))cpClearRetryRound(e,r);if(cpFinal(r)||cpApproval(r)||e?.kind==="approval"||cpAwaitingUserMethod(n))cpNotify(e)}catch(n){cpLog("handle-exception",{message:n?.message})}}
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
globalThis.__codexpatchObserveThreadStreamState=e=>{try{cpRememberAssistantOutput(e);cpObserveStreamFinalForRetry(e);let r=cpStreamInfo(e);if(r.status==="inProgress")cpHandle({source:"thread-stream-state",method:"thread-stream-state-changed",conversationId:e?.conversationId,threadId:e?.conversationId,status:r.status,params:e,snapshot:r.snapshot})}catch(r){cpLog("stream-observe-exception",{message:r?.message})}};
cpLog("loaded",{version:${JSON.stringify(VERSION)}});
return d.registerInternalNotificationHandler(Re=>{if(Re.method==="turn/completed"){E.emit("turnComplete");try{let e=Re.params||{},r=e.turn||{};cpHandle({source:"turn-completed",method:Re.method,conversationId:e.threadId,threadId:e.threadId,turnId:r.id,status:r.status,error:r.error,params:e})}catch(e){cpLog("turn-completed-exception",{message:e?.message})}}});
})());`;

const MCP_LIFECYCLE_ANCHOR =
  'handleMcpNotification(e){let r=this.extractConversationId(e.params);if(r)switch(e.method){case"codex/event/task_started":this.updateConversationStatus(r,2);break;case"codex/event/task_complete":this.updateConversationStatus(r,1);break;case"codex/event/turn_aborted":case"codex/event/error":case"codex/event/stream_error":this.updateConversationStatus(r,0);break;default:break}}';

const MCP_LIFECYCLE_PATCH =
  'handleMcpNotification(e){let r=this.extractConversationId(e.params);switch(e.method){case"codex/event/exec_approval_request":case"codex/event/apply_patch_approval_request":globalThis.__codexpatchNotifyConversationEnd?.({source:"mcp",method:e.method,conversationId:r||"global",status:"approval_needed",kind:"approval",params:e.params});break;case"codex/event/request_user_input":case"codex/event/elicitation_request":case"codex/event/dynamic_tool_call_request":globalThis.__codexpatchNotifyConversationEnd?.({source:"mcp",method:e.method,conversationId:r||"global",status:"input_needed",kind:"approval",params:e.params});break;case"codex/event/task_started":if(r)this.updateConversationStatus(r,2),globalThis.__codexpatchNotifyConversationStart?.(r);break;case"codex/event/task_complete":if(r)this.updateConversationStatus(r,1),globalThis.__codexpatchNotifyConversationEnd?.({source:"mcp",method:e.method,conversationId:r,status:"completed",params:e.params});break;case"codex/event/turn_aborted":if(r)globalThis.__codexpatchNotifyConversationEnd?.({source:"mcp",method:e.method,conversationId:r,status:"interrupted",params:e.params}),this.updateConversationStatus(r,0);break;case"codex/event/error":case"codex/event/stream_error":if(r)globalThis.__codexpatchNotifyConversationEnd?.({source:"mcp",method:e.method,conversationId:r,status:"failed",params:e.params}),this.updateConversationStatus(r,0);break;default:break}}/* codexpatch:v1:mcp-lifecycle-conversation-end */';

const APP_SERVER_REQUEST_PATTERN =
  /onRequest:([A-Za-z_$][\w$]*)=>\{this\.broadcastToAllViews\(\{type:"mcp-request",hostId:"local",request:\1\}\)\}/;

const THREAD_STREAM_STATE_PATTERN = /case"thread-stream-state-changed":\{/;

const USER_INTERRUPT_ANCHOR =
  'c=r.addRequestHandler("thread-follower-interrupt-turn",async x=>await this.getThreadRole(e,x.conversationId)==="owner",async x=>this.handleThreadFollowerInterruptTurnRequest(e,x.requestId,x.params)),';

const USER_INTERRUPT_PATCH =
  'c=r.addRequestHandler("thread-follower-interrupt-turn",async x=>await this.getThreadRole(e,x.conversationId)==="owner",async x=>(globalThis.__codexpatchMarkUserInterrupt?.({source:"thread-follower",method:"thread-follower-interrupt-turn",conversationId:x.conversationId,requestId:x.requestId,params:x.params}),this.handleThreadFollowerInterruptTurnRequest(e,x.requestId,x.params))),/* codexpatch:v1:user-interrupt-suppress */';

const HOST_MESSAGE_ANCHOR =
  'switch(r.type){case"ready":break;case"persisted-atom-sync-request":';

const HOST_MESSAGE_PATCH =
  'switch(r.type){case"codexpatch-settings-update":{/* codexpatch:v3:host-settings */try{globalThis.__codexpatchBroadcastToWebview=O=>{try{this.broadcastToAllViews(O)}catch(e){globalThis.__codexpatchLog?.("broadcast-exception",{message:e?.message})}};let n=r.settings||{};globalThis.__codexpatchSettings={notify:n.notify!==false,autoRetry:n.autoRetry!==false,retryDelayMs:Number(n.retryDelayMs)||1500};globalThis.__codexpatchLog?.("settings-update",globalThis.__codexpatchSettings)}catch(_){}break}case"codexpatch-user-interrupt":{try{globalThis.__codexpatchMarkUserInterrupt?.({source:"webview",method:r.method||"codexpatch-user-interrupt",conversationId:r.conversationId,threadId:r.threadId,turnId:r.turnId,requestId:r.requestId,params:r})}catch(e){globalThis.__codexpatchLog?.("webview-user-interrupt-exception",{message:e?.message})}break}case"codexpatch-notify":{try{globalThis.__codexpatchNotifySystem?.({source:"webview",method:"codexpatch/"+(r.kind||"notify"),conversationId:r.conversationId,status:r.status||"approval_needed",kind:r.kind||"info",message:r.message||r.body||"",body:r.body||r.message||""})}catch(e){globalThis.__codexpatchLog?.("webview-notify-exception",{message:e?.message})}break}case"codexpatch-diagnostic":{try{globalThis.__codexpatchLog?.("webview-"+(r.event||"event"),r)}catch(_){}break}case"ready":break;case"persisted-atom-sync-request":';

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
    notify: options.runtimeNotify !== false,
    autoRetry: options.autoRetry !== false,
    retryDelayMs: 1500
  };
}

function buildNotificationHandler(options, identifiers) {
  const settings = JSON.stringify(buildInitialSettings(options));
  const handler = V10_NOTIFICATION_HANDLER.replace(
    "function cpText(e){",
    `globalThis.__codexpatchSettings=${settings};\nfunction cpText(e){`
  );
  if (!identifiers) return handler;
  const { subscriptions, connection, notification, eventEmitter } = identifiers;
  return handler
    .replace("e.push((()=>{", `${subscriptions}.push((()=>{`)
    .replace(
      'return d.registerInternalNotificationHandler(Re=>{if(Re.method==="turn/completed"){E.emit("turnComplete");try{let e=Re.params||{},r=e.turn||{};cpHandle({source:"turn-completed",method:Re.method,conversationId:e.threadId,threadId:e.threadId,turnId:r.id,status:r.status,error:r.error,params:e})}catch(e){cpLog("turn-completed-exception",{message:e?.message})}}});',
      `return ${connection}.registerInternalNotificationHandler(${notification}=>{if(${notification}.method==="turn/completed"){${eventEmitter}.emit("turnComplete");try{let e=${notification}.params||{},r=e.turn||{};cpHandle({source:"turn-completed",method:${notification}.method,conversationId:e.threadId,threadId:e.threadId,turnId:r.id,status:r.status,error:r.error,params:e})}catch(e){cpLog("turn-completed-exception",{message:e?.message})}}});`
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

const APP_MAIN_INTERRUPT_PATTERN =
  /"interrupt-conversation":([A-Za-z_$][\w$]*)\(async\(([A-Za-z_$][\w$]*),\{conversationId:([A-Za-z_$][\w$]*),initiatedBy:([A-Za-z_$][\w$]*)\},([A-Za-z_$][\w$]*)\)=>\{let ([A-Za-z_$][\w$]*)=await \2\.interruptConversation\(\3\);\4===`user`&&\6!=null&&\5\.markTurnInterruptedByThisClient\(\3,\6\)\}\)/;

const APP_MAIN_FOLLOWER_INTERRUPT_PATTERN =
  /"thread-follower-interrupt-turn-for-host":([A-Za-z_$][\w$]*)\(async\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)=>\(\2\.assertThreadFollowerOwner\(\3\.conversationId\),\{interruptedTurnId:await \2\.interruptConversation\(\3\.conversationId\),ok:!0\}\)\)/;

const APP_MAIN_AUTO_RETRY_PATTERN =
  /(case`ipc-broadcast`:(?<event>[A-Za-z_$][\w$]*)\.method===`automation-capability-event`&&\k<event>\.sourceClientId===`desktop`&&\k<event>\.version===[A-Za-z_$][\w$]*\(`automation-capability-event`\)&&[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\.getForHostId\(\k<event>\.params\.hostId\),\k<event>\.params\),[A-Za-z_$][\w$]*\(\{claimAppConnectOAuthCallback:[A-Za-z_$][\w$]*,isCompactWindow:[A-Za-z_$][\w$]*,message:\k<event>,navigate:[A-Za-z_$][\w$]*,queryClient:[A-Za-z_$][\w$]*\}\);break (?<label>bb\d+);)(case`thread-follower-start-turn-request`:try\{let (?<result>[A-Za-z_$][\w$]*)=await (?<request>[A-Za-z_$][\w$]*)\(`thread-follower-start-turn-for-host`,\{hostId:\k<event>\.hostId,\.\.\.\k<event>\.params\}\);(?<dispatch>[A-Za-z_$][\w$]*)\.dispatchMessage\(`thread-follower-start-turn-response`,\{requestId:\k<event>\.requestId,result:\k<result>\}\))/;

function patchNotificationRegistration(source, options) {
  return replaceExactlyOnceByPattern(
    source,
    ORIGINAL_NOTIFICATION_PATTERN,
    (match) =>
      buildNotificationHandler(options, {
        subscriptions: match[1],
        connection: match[2],
        notification: match[3],
        eventEmitter: match[4]
      }),
    "notification registration anchor in clean baseline"
  );
}

function patchAppServerRequest(source) {
  return replaceExactlyOnceByPattern(
    source,
    APP_SERVER_REQUEST_PATTERN,
    (match) => {
      const request = match[1];
      return `onRequest:${request}=>{try{globalThis.__codexpatchBroadcastToWebview=O=>{try{this.broadcastToAllViews(O)}catch(e){globalThis.__codexpatchLog?.("broadcast-exception",{message:e?.message})}};globalThis.__codexpatchObserveAppServerRequest?.(${request})}catch(_){}this.broadcastToAllViews({type:"mcp-request",hostId:"local",request:${request}})}/* ${MARKERS.appServerRequest} */`;
    },
    "app server request anchor in clean baseline"
  );
}

function patchThreadStreamState(source) {
  return replaceExactlyOnceByPattern(
    source,
    THREAD_STREAM_STATE_PATTERN,
    () =>
      `case"thread-stream-state-changed":{/* ${MARKERS.threadStreamState} */try{globalThis.__codexpatchBroadcastToWebview=O=>{try{this.broadcastToAllViews(O)}catch(e){globalThis.__codexpatchLog?.("broadcast-exception",{message:e?.message})}};globalThis.__codexpatchObserveThreadStreamState?.(r)}catch(_){}`,
    "thread stream state anchor in clean baseline"
  );
}

function patchAppMainInterrupt(source) {
  return replaceExactlyOnceByPattern(
    source,
    APP_MAIN_INTERRUPT_PATTERN,
    (match) => {
      const [, wrapper, manager, conversationId, initiatedBy, context, interruptedTurnId] = match;
      return `"interrupt-conversation":${wrapper}(async(${manager},{conversationId:${conversationId},initiatedBy:${initiatedBy}},${context})=>{${initiatedBy}===\`user\`&&globalThis.__codexpatchPostUserInterrupt?.({conversationId:${conversationId},method:"interrupt-conversation",initiatedBy:${initiatedBy}});let ${interruptedTurnId}=await ${manager}.interruptConversation(${conversationId});${initiatedBy}===\`user\`&&${interruptedTurnId}!=null&&(globalThis.__codexpatchPostUserInterrupt?.({conversationId:${conversationId},turnId:${interruptedTurnId},method:"interrupt-conversation",initiatedBy:${initiatedBy}}),${context}.markTurnInterruptedByThisClient(${conversationId},${interruptedTurnId}))})/* ${MARKERS.webviewUserInterrupt} */`;
    },
    "webview interrupt-conversation anchor in clean baseline"
  );
}

function patchAppMainFollowerInterrupt(source) {
  return replaceExactlyOnceByPattern(
    source,
    APP_MAIN_FOLLOWER_INTERRUPT_PATTERN,
    (match) => {
      const [, wrapper, manager, request] = match;
      return `"thread-follower-interrupt-turn-for-host":${wrapper}(async(${manager},${request})=>(${manager}.assertThreadFollowerOwner(${request}.conversationId),globalThis.__codexpatchPostUserInterrupt?.({conversationId:${request}.conversationId,requestId:${request}.requestId,method:"thread-follower-interrupt-turn-for-host"}),{interruptedTurnId:await ${manager}.interruptConversation(${request}.conversationId),ok:!0}))/* ${MARKERS.webviewUserInterrupt} */`;
    },
    "webview follower interrupt anchor in clean baseline"
  );
}

function patchAppMainRetryCommands(source, plan) {
  if (!plan || plan.state !== "FOUND") {
    throw new Error("Webview retry commands require a resolved symbol plan.");
  }
  if (
    !Number.isInteger(plan.handlerKeyOffset) ||
    !plan.offsets ||
    !Number.isInteger(plan.offsets.bodyEnd) ||
    !source.startsWith(plan.handlerKey, plan.handlerKeyOffset)
  ) {
    throw new Error("Webview retry symbol plan does not match the bundle.");
  }
  const handlerSource = source.slice(plan.handlerKeyOffset, plan.offsets.bodyEnd + 1);
  if (sha256(handlerSource) !== plan.evidenceHash) {
    throw new Error("Webview retry symbol evidence changed before patch installation.");
  }
  const patch =
    '"codexpatch-retry-turn-for-host":CP_WRAPPER(async(e,{conversationId:t,turnId:n,model:r})=>{let i=CP_LOOKUP(e.getConversation(t),n);if(i==null)throw Error(`Turn not found.`);if(i.status===`inProgress`&&await e.interruptConversation(t)!==i.turnId)throw Error(`The turn is no longer active.`);let a=e.getConversation(t);if(a==null)throw Error(`Conversation state not found.`);CP_ROLLBACK(e,{conversationId:t,conversationState:a,rollbackResponse:await e.sendRequest(`thread/rollback`,{threadId:t,numTurns:1})});let o=(0,CP_OMIT.default)(i.params,[`clientUserMessageId`,`threadId`]),s=r??i.params?.model??o.model??a.latestModel??null;await CP_START(e,t,{...o,model:s,inheritThreadSettings:!1})}),"codexpatch-send-retry-message-for-host":CP_WRAPPER(async(e,{conversationId:t,turnId:n,model:r,text:i})=>{/* CP_MARKER */let a=e.getConversation(t);if(a==null)throw Error(`Conversation state not found.`);let o=n?CP_LOOKUP(a,n):null;if(n&&o==null)throw Error(`Turn not found.`);if(o?.status===`inProgress`&&await e.interruptConversation(t)!==o.turnId)throw Error(`The turn is no longer active.`);let s=o?.params?(0,CP_OMIT.default)(o.params,[`clientUserMessageId`,`threadId`,`input`,`attachments`,`commentAttachments`]):{},c=r??o?.params?.model??s.model??a.latestModel??null,l=typeof i===`string`&&i.trim()?i:`retry`;await CP_START(e,t,{...s,input:[{type:`text`,text:l,text_elements:[]}],model:c,inheritThreadSettings:!1})}),';
  const replacement = patch
    .replaceAll("CP_WRAPPER", plan.commandWrapper)
    .replaceAll("CP_LOOKUP", plan.turnLookup)
    .replaceAll("CP_ROLLBACK", plan.applyRollback)
    .replaceAll("CP_OMIT", plan.omitModule)
    .replaceAll("CP_START", plan.startTurn)
    .replaceAll("CP_MARKER", MARKERS.webviewAutoRetryCommand);
  return (
    source.slice(0, plan.handlerKeyOffset) +
    replacement +
    source.slice(plan.handlerKeyOffset)
  );
}

function patchAppMainAutoRetry(source) {
  return replaceExactlyOnceByPattern(
    source,
    APP_MAIN_AUTO_RETRY_PATTERN,
    (match) => {
      const { event, label, request, dispatch } = match.groups;
      const patch =
        'case`codexpatch-auto-retry`:{/* codexpatch:v7:webview-auto-retry-message-reuse */try{let t=CP_EVENT.conversationId??CP_EVENT.threadId,n=CP_EVENT.turnId,o=CP_EVENT.model??null,i=CP_EVENT.mode??`rollback`,a=CP_EVENT.allowMessageRetry===!0&&(i===`message`||i===`edit-message`);if(i===`rollback`&&CP_EVENT.hadTrackedOutput!==!1){CP_DISPATCH.dispatchMessage(`codexpatch-diagnostic`,{event:`auto-retry-send-skip-output-boundary`,conversationId:t||``,turnId:n||``,outputState:CP_EVENT.outputState||`unknown`});break CP_LABEL}if(i!==`rollback`&&!a){CP_DISPATCH.dispatchMessage(`codexpatch-diagnostic`,{event:`auto-retry-send-skip-message-boundary`,conversationId:t||``,turnId:n||``,mode:i});break CP_LABEL}if(!t||!a&&!n){CP_DISPATCH.dispatchMessage(`codexpatch-diagnostic`,{event:`auto-retry-send-skip-missing-context`,conversationId:t||``,turnId:n||``,mode:i});break CP_LABEL}let s=globalThis.__codexpatchRetrySent||(globalThis.__codexpatchRetrySent=new Map),c=t+`|`+(n||`latest`)+`|`+i,l=Date.now(),u=s.get(c);if(u&&l-u<3e4){CP_DISPATCH.dispatchMessage(`codexpatch-diagnostic`,{event:`auto-retry-send-skip-duplicate`,conversationId:t,turnId:n,mode:i});break CP_LABEL}for(let[e,t]of s)try{l-t>12e4&&s.delete(e)}catch{}s.set(c,l);try{let r=`codexpatch:auto-retry:`+c,a=localStorage.getItem(r),d=a?Number(a.split(`:`)[0]):0;if(d&&l-d<3e4){CP_DISPATCH.dispatchMessage(`codexpatch-diagnostic`,{event:`auto-retry-send-skip-shared-duplicate`,conversationId:t,turnId:n,mode:i});break CP_LABEL}let f=l+`:`+Math.random().toString(36).slice(2);localStorage.setItem(r,f);await new Promise(e=>setTimeout(e,30));if(localStorage.getItem(r)!==f){CP_DISPATCH.dispatchMessage(`codexpatch-diagnostic`,{event:`auto-retry-send-skip-shared-lost`,conversationId:t,turnId:n,mode:i});break CP_LABEL}}catch{}let f=i===`edit-message`?`thread-follower-edit-last-user-turn-for-host`:a?`codexpatch-send-retry-message-for-host`:`codexpatch-retry-turn-for-host`,p={hostId:CP_EVENT.hostId??`local`,conversationId:t,turnId:n,model:o,text:CP_EVENT.retryText??`retry`};i===`edit-message`&&(p={hostId:p.hostId,conversationId:t,turnId:n,message:p.text});CP_DISPATCH.dispatchMessage(`codexpatch-diagnostic`,{event:i===`edit-message`?`auto-retry-message-edit`:a?`auto-retry-message-send`:`auto-retry-send`,conversationId:t,turnId:n,model:o||``});await CP_REQUEST(f,p);CP_DISPATCH.dispatchMessage(`codexpatch-diagnostic`,{event:i===`edit-message`?`auto-retry-message-edit-ok`:a?`auto-retry-message-send-ok`:`auto-retry-send-ok`,conversationId:t,turnId:n})}catch(t){CP_DISPATCH.dispatchMessage(`codexpatch-diagnostic`,{event:`auto-retry-send-error`,conversationId:CP_EVENT.conversationId||CP_EVENT.threadId||``,message:String(t).slice(0,500)})}break CP_LABEL}';
      return (
        patch
          .replaceAll("CP_EVENT", event)
          .replaceAll("CP_LABEL", label)
          .replaceAll("CP_DISPATCH", dispatch)
          .replaceAll("CP_REQUEST", request) + match[0]
      );
    },
    "webview auto retry message anchor in clean baseline"
  );
}

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
      cleanupOldExtensionState(extensionDir);
      if (options.installNotify !== false) showScriptNotification("vscodexkit 已安装", "检测通过，脚本正常工作。", "Info");
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
    installNotify: true,
    runtimeNotify: true,
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
      options.extensionDir = stripMatchingQuotes(value);
    } else if (arg === "--skip-syntax-check") {
      options.skipSyntaxCheck = true;
    } else if (arg === "--notify") {
      options.installNotify = true;
    } else if (arg === "--no-notify") {
      options.installNotify = false;
    } else if (arg === "--runtime-notify") {
      options.runtimeNotify = true;
    } else if (arg === "--no-runtime-notify") {
      options.runtimeNotify = false;
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

function stripMatchingQuotes(value) {
  if (typeof value !== "string" || value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function usage(error) {
  if (error) {
    console.error(error);
    console.error("");
  }

  console.error(`vscodexkit ${VERSION}

Usage:
  node ./bin/vscodexkit.js check [--extension-dir <dir>]
  node ./bin/vscodexkit.js apply [--extension-dir <dir>] [--notify|--no-notify] [--runtime-notify|--no-runtime-notify] [--auto-retry|--no-auto-retry] [--skip-syntax-check]
  node ./bin/vscodexkit.js restore [--extension-dir <dir>]
  node ./bin/vscodexkit.js uninstall [--extension-dir <dir>]
  node ./bin/vscodexkit.js test-notify

Notes:
  - Only the VSCode extension install directory is patched.
  - --notify/--no-notify only controls the install success notification.
  - Runtime Codex notifications default to --runtime-notify; auto retry defaults to --auto-retry.
  - Runtime notifications are also sent to every adb device whose state is device.
  - A single clean baseline is kept under .codexpatch/original.
  - VSCode user data, globalStorage, workspaceStorage, and project files are not touched.
  - uninstall restores the clean baseline and removes vscodexkit state.
  - Reload VSCode after apply/restore/uninstall.`);
  process.exit(error ? 1 : 0);
}

function runNotificationTest() {
  const title = "vscodexkit 测试";
  const body = "如果看到这条，通知通道可用。";
  if (process.platform === "win32") {
    const shortcutTarget = findVsCodeExecutable() || process.execPath;
    childProcess.execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Sta", "-Command", WINDOWS_SYSTEM_NOTIFY_PS_V7],
      {
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...process.env,
          CODEXPATCH_TITLE: title,
          CODEXPATCH_BODY: body,
          CODEXPATCH_ICON: "Info",
          CODEXPATCH_AUMID: "vscodexkit.VSCode",
          CODEXPATCH_SHORTCUT_TARGET: shortcutTarget,
          CODEXPATCH_SHORTCUT_ICON: shortcutTarget
        }
      }
    );
    console.log("Windows notification test finished.");
  } else {
    console.log("Windows notification test skipped on this platform.");
  }
  runAdbNotificationTest(title, body, "test");
}

function runAdbNotificationTest(title, body, event) {
  const adb = findAdbExecutable();
  let output;
  try {
    output = childProcess.execFileSync(adb, ["devices"], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    console.log(`ADB notification test skipped: ${error.message}`);
    return;
  }

  const serials = parseAdbDeviceSerials(output);
  if (serials.length === 0) {
    console.log("ADB notification test skipped: no connected devices in state=device.");
    return;
  }
  for (const serial of serials) {
    try {
      childProcess.execFileSync(
        adb,
        ["-s", serial, ...buildAdbNotificationArgs(title, body, event)],
        {
          encoding: "utf8",
          timeout: 8000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      console.log(`ADB notification test sent: ${serial}`);
    } catch (error) {
      console.log(`ADB notification test failed: ${serial}: ${error.message}`);
    }
  }
}

function findAdbExecutable() {
  const executable = process.platform === "win32" ? "adb.exe" : "adb";
  const candidates = [
    process.env.CODEXPATCH_ADB_PATH,
    process.env.ANDROID_HOME &&
      path.join(process.env.ANDROID_HOME, "platform-tools", executable),
    process.env.ANDROID_SDK_ROOT &&
      path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", executable),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", executable)
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || executable;
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
  const webviewAppMain = findWebviewAppMain(extensionDir);
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

function findWebviewAppMain(extensionDir) {
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
    if (
      source.includes(MARKERS.webviewUserInterrupt) ||
      WEBVIEW_APP_MAIN_NEEDLES.every((needle) => source.includes(needle))
    ) {
      matches.push(filePath);
    }
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
  const webviewRetrySymbolResolution = inspectWebviewRetryPlan(appMainSource);
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
    notificationAnchorCount: countPatternMatches(extensionSource, ORIGINAL_NOTIFICATION_PATTERN),
    mcpLifecyclePatched: extensionSource.includes(MARKERS.mcpLifecycle),
    mcpLifecycleAnchorCount: countOccurrences(extensionSource, MCP_LIFECYCLE_ANCHOR),
    appServerRequestPatched: extensionSource.includes(MARKERS.appServerRequest),
    appServerRequestAnchorCount: countPatternMatches(extensionSource, APP_SERVER_REQUEST_PATTERN),
    threadStreamStatePatched: extensionSource.includes(MARKERS.threadStreamState),
    threadStreamStateAnchorCount: countPatternMatches(extensionSource, THREAD_STREAM_STATE_PATTERN),
    userInterruptPatched: extensionSource.includes(MARKERS.userInterrupt),
    userInterruptAnchorCount: countOccurrences(extensionSource, USER_INTERRUPT_ANCHOR),
    webviewUserInterruptPatched: appMainSource.includes(MARKERS.webviewUserInterrupt),
    webviewInterruptAnchorCount: countPatternMatches(appMainSource, APP_MAIN_INTERRUPT_PATTERN),
    webviewFollowerInterruptAnchorCount: countPatternMatches(
      appMainSource,
      APP_MAIN_FOLLOWER_INTERRUPT_PATTERN
    ),
    webviewAutoRetryPatched: appMainSource.includes(MARKERS.webviewAutoRetry),
    webviewAutoRetryCommandPatched: appMainSource.includes(MARKERS.webviewAutoRetryCommand),
    webviewAutoRetryCommandAnchorCount: countOccurrences(appMainSource, RETRY_HANDLER_KEY),
    webviewRetrySymbolResolution,
    webviewAutoRetryAnchorCount: countPatternMatches(appMainSource, APP_MAIN_AUTO_RETRY_PATTERN),
    hostSettingsPatched: extensionSource.includes(MARKERS.hostSettings),
    hostSettingsAnchorCount: countOccurrences(extensionSource, HOST_MESSAGE_ANCHOR),
    webviewIndexPatched: indexSource.includes(MARKERS.webviewIndex),
    webviewIndexAnchorCount: countWebviewEntryScriptAnchors(indexSource),
    webviewUiExists: uiExists,
    webviewUiPatched: uiSource.includes(MARKERS.webviewUi)
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
    status.notificationPatched &&
    status.mcpLifecyclePatched &&
    status.appServerRequestPatched &&
    status.threadStreamStatePatched &&
    status.userInterruptPatched &&
    status.hostSettingsPatched &&
    status.webviewIndexPatched &&
    status.webviewUiPatched &&
    status.webviewUserInterruptPatched &&
    status.webviewAutoRetryPatched &&
    status.webviewAutoRetryCommandPatched &&
    status.webviewRetrySymbolResolution.state === "FOUND"
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
  console.log(`Notify:    ${status.notificationPatched ? "yes" : "no"}`);
  console.log(`Lifecycle:  ${status.mcpLifecyclePatched ? "yes" : "no"}`);
  console.log(`App req:    ${status.appServerRequestPatched ? "yes" : "no"}`);
  console.log(`Stream:     ${status.threadStreamStatePatched ? "yes" : "no"}`);
  console.log(`Interrupt:  ${status.userInterruptPatched ? "yes" : "no"}`);
  console.log(`Settings:   ${status.hostSettingsPatched ? "yes" : "no"}`);
  console.log(`WV index:   ${status.webviewIndexPatched ? "yes" : "no"}`);
  console.log(`WV UI:      ${status.webviewUiPatched ? "yes" : "no"}`);
  console.log(`WV int:     ${status.webviewUserInterruptPatched ? "yes" : "no"}`);
  console.log(`WV retry:   ${status.webviewAutoRetryPatched ? "yes" : "no"}`);
  console.log(`WV retry cmd: ${status.webviewAutoRetryCommandPatched ? "yes" : "no"}`);
  console.log(
    `WV symbols: HookPoint[${status.webviewRetrySymbolResolution.hookPoint}] state=${status.webviewRetrySymbolResolution.state} rule=${status.webviewRetrySymbolResolution.ruleVersion}` +
      (status.webviewRetrySymbolResolution.evidenceHash
        ? ` evidence=${status.webviewRetrySymbolResolution.evidenceHash.slice(0, 12)}`
        : "")
  );
  if (status.webviewRetrySymbolResolution.error) {
    console.log(`WV sym err: ${status.webviewRetrySymbolResolution.error}`);
  }
  console.log(`Anchors:    notify=${status.notificationAnchorCount} lifecycle=${status.mcpLifecycleAnchorCount} appReq=${status.appServerRequestAnchorCount} stream=${status.threadStreamStateAnchorCount} interrupt=${status.userInterruptAnchorCount} host=${status.hostSettingsAnchorCount} webview=${status.webviewIndexAnchorCount} wvInt=${status.webviewInterruptAnchorCount}/${status.webviewFollowerInterruptAnchorCount} wvRetry=${status.webviewAutoRetryAnchorCount} wvRetryCmd=${status.webviewAutoRetryCommandAnchorCount}`);

  const ok = isPatchStatusOk(status);
  console.log(`Status:     ${ok ? "ok" : "unsupported bundle shape; apply will fail closed"}`);
}

function findWebviewEntryScriptAnchors(source) {
  const regex =
    /<script\b(?=[^>]*\btype=(["'])module\1)(?=[^>]*\bsrc=(["'])\.\/assets\/index-[^"']+\.js\2)[^>]*><\/script>/g;
  const matches = [];
  for (const match of source.matchAll(regex)) {
    matches.push(match[0]);
  }
  return matches;
}

function countWebviewEntryScriptAnchors(source) {
  return findWebviewEntryScriptAnchors(source).length;
}

function patchWebviewIndex(source) {
  const anchors = findWebviewEntryScriptAnchors(source);
  if (anchors.length !== 1) {
    throw new Error(`Expected exactly one webview entry script anchor in clean baseline, found ${anchors.length}.`);
  }
  const anchor = anchors[0];
  const replacement =
    `<script type="module" crossorigin src="./assets/codexpatch-ui.js"></script><!-- ${MARKERS.webviewIndex} -->\n    ${anchor}`;
  return source.replace(anchor, replacement);
}

function applyPatch(extensionDir, manifest, files, options) {
  const status = getPatchStatus(files);
  const baseline = ensureBaseline(extensionDir, manifest, files, status);
  const webviewUiSource = buildWebviewUiSourceLite(options);

  const extensionSourceWithNotify = patchNotificationRegistration(baseline.extensionSource, options);
  const extensionSourceWithHostSettings = replaceExactlyOnce(
    extensionSourceWithNotify,
    HOST_MESSAGE_ANCHOR,
    HOST_MESSAGE_PATCH,
    "host message anchor in clean baseline"
  );
  const extensionSourceWithAppServerRequest = patchAppServerRequest(extensionSourceWithHostSettings);
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
  const extensionSource = patchThreadStreamState(extensionSourceWithUserInterrupt);
  const indexSource = patchWebviewIndex(baseline.indexSource);
  const appMainWithInterrupt = patchAppMainInterrupt(baseline.appMainSource);
  const appMainWithFollowerInterrupt = patchAppMainFollowerInterrupt(appMainWithInterrupt);
  const retryPlan = resolveWebviewRetryPlan(appMainWithFollowerInterrupt);
  console.log(
    `HookPoint[${retryPlan.hookPoint}] state=${retryPlan.state} rule=${retryPlan.ruleVersion} evidence=${retryPlan.evidenceHash.slice(0, 12)}`
  );
  const appMainWithAutoRetryCommand = patchAppMainRetryCommands(
    appMainWithFollowerInterrupt,
    retryPlan
  );
  const appMainSource = patchAppMainAutoRetry(appMainWithAutoRetryCommand);

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

function countPatternMatches(source, pattern) {
  return findPatternMatches(source, pattern).length;
}

function replaceExactlyOnceByPattern(source, pattern, buildReplacement, label) {
  const matches = findPatternMatches(source, pattern);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${matches.length}.`);
  }
  const match = matches[0];
  const replacement = buildReplacement(match);
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

function findPatternMatches(source, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return Array.from(source.matchAll(new RegExp(pattern.source, flags)));
}

function restorePatch(extensionDir, manifest, files, options = {}) {
  const baseline = loadBaseline(manifest, files);
  if (baseline) {
    const restored = restoreFilesFromBaseline(baseline, files);
    if (options.uninstall) {
      removeNotificationShortcuts();
      removeBaseline(extensionDir, files);
    }

    const action = options.uninstall ? "Uninstalled" : "Restored from clean baseline";
    console.log(`${action}: ${manifest.publisher}.${manifest.name}@${manifest.version}`);
    for (const entry of restored) {
      console.log(`- ${entry.filePath} <= ${entry.backup}`);
    }
    console.log("Reload VSCode to load the restored extension.");
    return;
  }

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

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = {
  buildAdbNotificationArgs,
  findWebviewAppMain,
  parseAdbDeviceSerials,
  patchAppMainAutoRetry,
  patchAppMainFollowerInterrupt,
  patchAppMainInterrupt,
  patchAppMainRetryCommands,
  patchAppServerRequest,
  patchNotificationRegistration,
  patchThreadStreamState
};
