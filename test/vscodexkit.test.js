"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  buildAdbNotificationArgs,
  findWebviewAppMain,
  parseAdbDeviceSerials,
  patchAppMainAutoRetry,
  patchAppMainFollowerInterrupt,
  patchAppMainInterrupt,
  patchAppMainRetryCommands,
  patchHostUserInterrupt,
  patchNotificationRegistration,
  patchThreadStreamState
} = require("../bin/vscodexkit.js");
const {
  RETRY_HANDLER_KEY,
  inspectWebviewRetryPlan,
  resolveWebviewRetryPlan
} = require("../lib/webview-symbol-resolver.js");

const CURRENT_APP_MAIN_SHAPE = [
  '"interrupt-conversation":WP(async(e,{conversationId:t,initiatedBy:n},r)=>{let i=await e.interruptConversation(t);n===`user`&&i!=null&&r.markTurnInterruptedByThisClient(t,i)})',
  '"thread-follower-interrupt-turn-for-host"',
  '"retry-safety-buffered-turn-for-host"',
  "case`thread-follower-start-turn-request`:"
].join(";");

test("locates an app-main bundle after minified wrapper names change", (t) => {
  const extensionDir = makeExtensionFixture(t);
  const assetsDir = path.join(extensionDir, "webview", "assets");
  fs.writeFileSync(path.join(assetsDir, "index-new.js"), '"interrupt-conversation"', "utf8");
  const expected = path.join(assetsDir, "app-main-new.js");
  fs.writeFileSync(expected, CURRENT_APP_MAIN_SHAPE, "utf8");

  assert.equal(findWebviewAppMain(extensionDir), expected);
});

test("locates the current app-main bundle after follower request events were removed", (t) => {
  const extensionDir = makeExtensionFixture(t);
  const assetsDir = path.join(extensionDir, "webview", "assets");
  const expected = path.join(assetsDir, "app-main-current.js");
  fs.writeFileSync(
    expected,
    [
      '"interrupt-conversation"',
      '"thread-follower-interrupt-turn-for-host"',
      '"retry-safety-buffered-turn-for-host"',
      "case`worker-response`:case`worker-event`:"
    ].join(";"),
    "utf8"
  );

  assert.equal(findWebviewAppMain(extensionDir), expected);
});

test("fails closed when app-main discovery is ambiguous", (t) => {
  const extensionDir = makeExtensionFixture(t);
  const assetsDir = path.join(extensionDir, "webview", "assets");
  fs.writeFileSync(path.join(assetsDir, "app-main-a.js"), CURRENT_APP_MAIN_SHAPE, "utf8");
  fs.writeFileSync(path.join(assetsDir, "app-main-b.js"), CURRENT_APP_MAIN_SHAPE, "utf8");

  assert.throws(() => findWebviewAppMain(extensionDir), /multiple candidate webview app bundles/);
});

test("preserves current notification callback identifiers", () => {
  const source =
    'items.push(connection.registerInternalNotificationHandler(notification=>{notification.method==="turn/completed"&&events.emit("turnComplete")}));';
  const patched = patchNotificationRegistration(source, {
    runtimeNotify: true,
    autoRetry: true
  });

  assert.match(patched, /codexpatch:v22:notification-types/);
  assert.match(patched, /return connection\.registerInternalNotificationHandler\(notification=>/);
  assert.match(patched, /events\.emit\("turnComplete"\)/);
  assert.match(patched, /cpNotifyAdb\(h,g,u\)/);
  assert.match(patched, /kind:"retry",params:\{\.\.\.g,errorMessage:y\}/);
  assert.match(patched, /if\(!x\.notified\)x\.notified=true,cpNotify/);
  assert.match(patched, /Codex 因错误中断，未执行自动重试/);
  assert.match(patched, /Codex 自动重试后助手已回应/);
  assert.match(patched, /Codex 需要审批命令/);
  assert.match(patched, /cpObserveNotification\(notification\)/);
  assert.match(patched, /notify-skip-stale-completed-during-retry/);
  assert.match(patched, /cpRestartRetryRound\(e\)/);
  assert.match(patched, /if\(n===\"unknown\"\)cpLog\(\"auto-retry-output-unknown-message-only\"/);
  assert.match(
    patched,
    /if\(r&&typeof r===\"object\"&&cpObjHasAssistantOutput\(r\)\)return\"present\"/
  );
  assert.match(patched, /if\(!i\)return\"unknown\"/);
  assert.match(patched, /s\.sourceTurnId=cpText\(e\?\.turnId\)/);
  assert.match(patched, /n\.activeTurnId=o,n\.awaitingRestart=false/);
  assert.match(patched, /auto-retry-terminal-restart-observed/);
  assert.match(patched, /i!==o\.sourceTurnId/);
  assert.match(patched, /auto-retry-skip-unproven-terminal/);
  assert.doesNotMatch(patched, /r===\"mcp\"/);
  assert.match(patched, /a=n===\"absent\"\?\"rollback\"/);
  assert.match(patched, /\"edit-message\":\"message\"/);
  assert.doesNotMatch(patched, /return d\.registerInternalNotificationHandler\(Re=>/);
});

test("retries unknown output without rollback and rejects a stale terminal", () => {
  const source =
    'items.push(connection.registerInternalNotificationHandler(notification=>{notification.method==="turn/completed"&&events.emit("turnComplete")}));';
  const patched = patchNotificationRegistration(source, {
    runtimeNotify: false,
    autoRetry: true
  });
  const context = {
    items: [],
    connection: {
      registerInternalNotificationHandler(handler) {
        return handler;
      }
    },
    events: { emit() {} },
    require() {
      throw new Error("disabled in retry replay");
    }
  };
  vm.runInNewContext(patched, context);
  const retries = [];
  context.__codexpatchBroadcastToWebview = (message) => retries.push(message);

  context.items[0]({
    method: "turn/completed",
    params: {
      threadId: "conversation-1",
      turn: {
        id: "turn-1",
        status: "failed",
        error: { message: "We're currently experiencing high demand, which may cause temporary errors." }
      }
    }
  });
  assert.equal(retries.length, 1);
  assert.equal(retries[0].outputState, "unknown");
  assert.equal(retries[0].mode, "message");
  assert.equal(retries[0].allowMessageRetry, true);
  assert.equal(retries[0].hadTrackedOutput, false);

  context.items[0]({
    method: "turn/completed",
    params: {
      threadId: "conversation-1",
      turn: { id: "turn-1", status: "completed" }
    }
  });
  assert.equal(retries.length, 1);

  context.items[0]({
    method: "turn/completed",
    params: {
      threadId: "conversation-1",
      turn: {
        id: "turn-2",
        status: "failed",
        error: { message: "We're currently experiencing high demand, which may cause temporary errors." }
      }
    }
  });
  assert.equal(retries.length, 2);
  assert.equal(retries[1].mode, "edit-message");
  assert.equal(retries[1].turnId, "turn-2");
});

test("emits the five requested notification types from proven lifecycle events", () => {
  const source =
    'items.push(connection.registerInternalNotificationHandler(notification=>{notification.method==="turn/completed"&&events.emit("turnComplete")}));';
  const patched = patchNotificationRegistration(source, {
    runtimeNotify: true,
    autoRetry: true
  });
  const logLines = [];
  const retries = [];
  const context = {
    items: [],
    connection: {
      registerInternalNotificationHandler(handler) {
        return handler;
      }
    },
    events: { emit() {} },
    process: { env: {}, execPath: "codex", platform: "linux" },
    require(name) {
      if (name === "fs") {
        return {
          appendFileSync(_file, data) {
            logLines.push(String(data));
          }
        };
      }
      if (name === "os") return { tmpdir: () => "/tmp" };
      if (name === "path") return path;
      if (name === "child_process") {
        return {
          execFile(_file, _args, _options, callback) {
            callback(null, "List of devices attached\n", "");
          }
        };
      }
      throw new Error(`Unexpected module: ${name}`);
    }
  };
  vm.runInNewContext(patched, context);
  context.__codexpatchBroadcastToWebview = (message) => retries.push(message);

  context.items[0]({
    method: "turn/completed",
    params: {
      threadId: "no-retry",
      turn: {
        id: "failed-1",
        status: "failed",
        error: { message: "fatal local error" }
      }
    }
  });
  context.items[0]({
    method: "turn/completed",
    params: {
      threadId: "retry",
      turn: {
        id: "failed-2",
        status: "failed",
        error: { message: "We're currently experiencing high demand." }
      }
    }
  });
  context.items[0]({
    method: "turn/started",
    params: { threadId: "retry", turn: { id: "retry-1", status: "inProgress" } }
  });
  context.items[0]({
    method: "item/agentMessage/delta",
    params: { threadId: "retry", turnId: "retry-1", delta: "Recovered response" }
  });
  context.items[0]({
    method: "item/agentMessage/delta",
    params: { threadId: "retry", turnId: "retry-1", delta: "More response" }
  });
  context.__codexpatchObserveAppServerRequest({
    method: "item/commandExecution/requestApproval",
    id: "approval-1",
    params: { threadId: "approval" }
  });
  context.items[0]({
    method: "turn/completed",
    params: {
      threadId: "complete",
      turn: { id: "complete-1", status: "completed" }
    }
  });

  const sent = logLines
    .filter((line) => line.includes(" notify-send "))
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))));
  assert.equal(retries.length, 1);
  assert.equal(
    sent.filter((entry) => entry.body === "Codex 自动重试后助手已回应").length,
    1
  );
  assert.ok(
    sent.some((entry) =>
      entry.body.startsWith("Codex 因错误中断，未执行自动重试: fatal local error")
    )
  );
  assert.ok(
    sent.some((entry) =>
      entry.body.startsWith("Codex 因错误中断，正在自动重试")
    )
  );
  assert.ok(sent.some((entry) => entry.body === "Codex 需要审批命令"));
  assert.ok(sent.some((entry) => entry.body === "Codex 任务已完成"));
});

test("selects every connected adb device and excludes unavailable states", () => {
  const output = [
    "List of devices attached",
    "emulator-5554\tdevice product:sdk model:Pixel transport_id:1",
    "127.0.0.1:30126 offline transport_id:2",
    "R58M1234 unauthorized usb:1-2",
    "192.168.1.8:5555 device product:phone transport_id:3",
    "emulator-5554\tdevice product:sdk model:Pixel transport_id:1",
    ""
  ].join("\n");

  assert.deepEqual(parseAdbDeviceSerials(output), [
    "emulator-5554",
    "192.168.1.8:5555"
  ]);
});

test("encodes adb notification text without interpolating it into shell code", () => {
  const title = 'Codex "审批"; touch /data/local/tmp/bad';
  const body = "需要确认 $(id)\n第二行";
  const args = buildAdbNotificationArgs(title, body, "Approval Needed");

  assert.deepEqual(args.slice(0, 3), ["shell", "sh", "-c"]);
  assert.match(args[3], /vscodexkit-approval-needed/);
  assert.doesNotMatch(args[3], /touch|需要确认|\$\(id\)/);

  const match = args[3].match(
    /^title=\$\(printf %s ([A-Za-z0-9+/=]*)\|base64 -d\);body=\$\(printf %s ([A-Za-z0-9+/=]*)\|base64 -d\);/
  );
  assert.ok(match);
  assert.equal(Buffer.from(match[1], "base64").toString("utf8"), title);
  assert.equal(Buffer.from(match[2], "base64").toString("utf8"), "需要确认 $(id) 第二行");
});

test("patches the current webview interrupt wrapper", () => {
  const source =
    '"interrupt-conversation":WP(async(e,{conversationId:t,initiatedBy:n},r)=>{let i=await e.interruptConversation(t);n===`user`&&i!=null&&r.markTurnInterruptedByThisClient(t,i)})';
  const patched = patchAppMainInterrupt(source);

  assert.match(patched, /"interrupt-conversation":WP\(/);
  assert.match(patched, /codexpatch:v2:webview-user-interrupt/);
  assert.match(patched, /globalThis\.__codexpatchPostUserInterrupt/);
});

test("patches arbitrarily renamed follower interrupt bindings", () => {
  const source =
    '"thread-follower-interrupt-turn-for-host":makeHandler(async(manager,request)=>(manager.assertThreadFollowerOwner(request.conversationId),{interruptedTurnId:await manager.interruptConversation(request.conversationId),ok:!0}))';
  const patched = patchAppMainFollowerInterrupt(source);

  assert.match(
    patched,
    /"thread-follower-interrupt-turn-for-host":makeHandler\(async\(manager,request\)/
  );
  assert.match(
    patched,
    /conversationId:request\.conversationId,requestId:request\.requestId/
  );
  assert.match(patched, /codexpatch:v2:webview-user-interrupt/);
});

test("patches user interrupt tracking into the current generic follower handler", () => {
  const source =
    "function setup({hostId:h,ipcClient:i,viewService:v}){" +
    "let owner=async({conversationId:c})=>await v.getThreadRole({hostId:h,conversationId:c})===`owner`," +
    "register=(method,timeout=wait)=>i.addRequestHandler(method,owner,({params:p})=>" +
    "forward(v,h,{method:method,params:p},timeout)),handlers=[" +
    "register(`thread-follower-start-turn`),register(`thread-follower-interrupt-turn`)];}";
  const patched = patchHostUserInterrupt(source);

  assert.match(patched, /method===`thread-follower-interrupt-turn`/);
  assert.match(patched, /conversationId:p\.conversationId/);
  assert.match(patched, /forward\(v,h,\{method:method,params:p\},timeout\)/);
  assert.match(patched, /codexpatch:v1:user-interrupt-suppress/);
});

test("patches stream observation into the current broadcast dispatcher", () => {
  const source =
    'case"thread-stream-state-changed":await receiver.threadStreamStateChanged(' +
    "{sourceClientId:event.sourceClientId,params:event.params});return;";
  const patched = patchThreadStreamState(source);

  assert.match(patched, /__codexpatchObserveThreadStreamState\?\.\(event\.params\)/);
  assert.match(
    patched,
    /await receiver\.threadStreamStateChanged\(\{sourceClientId:event\.sourceClientId,params:event\.params\}\)/
  );
  assert.match(patched, /codexpatch:v2:thread-stream-state-conversation-end/);
});

test("webview rollback retry fails closed without proven empty output", () => {
  const source =
    "case`ipc-broadcast`:event.method===`automation-capability-event`&&" +
    "event.sourceClientId===`desktop`&&event.version===version(`automation-capability-event`)&&" +
    "forward(clients,hosts.getForHostId(event.params.hostId),event.params)," +
    "navigate({claimAppConnectOAuthCallback:claim,isCompactWindow:compact,message:event," +
    "navigate:go,queryClient:query});break bb7;" +
    "case`thread-follower-start-turn-request`:try{let result=await request(" +
    "`thread-follower-start-turn-for-host`,{hostId:event.hostId,...event.params});" +
    "dispatch.dispatchMessage(`thread-follower-start-turn-response`," +
    "{requestId:event.requestId,result:result})";
  const patched = patchAppMainAutoRetry(source);

  assert.match(patched, /hadTrackedOutput!==!1/);
  assert.match(patched, /auto-retry-send-skip-output-boundary/);
  assert.match(patched, /thread-follower-edit-last-user-turn-for-host/);
  assert.match(patched, /i===`edit-message`&&\(p=\{hostId:p\.hostId,conversationId:t,turnId:n,message:p\.text\}\)/);
  assert.ok(
    patched.indexOf("hadTrackedOutput!==!1") <
      patched.indexOf("codexpatch-retry-turn-for-host")
  );
});

test("patches auto retry into the current unified webview message switch", () => {
  const source =
    "if(methodSupported(message.method)&&requestHost(" +
    "`handle-app-server-notification-for-host`,{hostId:message.hostId," +
    "notification:{method:message.method,params:message.params}})}," +
    "handleMessage=async event=>{if(!isHostMessage(event))bb63:switch(event.type){" +
    "case`worker-response`:case`worker-event`:break bb63;";
  const patched = patchAppMainAutoRetry(source);

  assert.match(patched, /case`codexpatch-auto-retry`/);
  assert.match(patched, /await requestHost\(command,params\)/);
  assert.match(patched, /break bb63/);
  assert.ok(
    patched.indexOf("case`codexpatch-auto-retry`") <
      patched.indexOf("case`worker-response`")
  );
});

test("resolves and patches arbitrarily renamed retry symbols", () => {
  const source = makeRetryHandler({
    wrapper: "commandFactory",
    manager: "bridgeState",
    conversationId: "threadKey",
    turnId: "bufferedTurnKey",
    model: "requestedModel",
    turnLookup: "selectBufferedTurn",
    applyRollback: "commitRollbackState",
    omitModule: "objectWithoutKeys",
    startTurn: "launchBufferedTurn",
    fields: "model:requestedModel, turnId:bufferedTurnKey, conversationId:threadKey"
  });

  const plan = resolveWebviewRetryPlan(source);
  assert.equal(plan.state, "FOUND");
  assert.equal(plan.commandWrapper, "commandFactory");
  assert.equal(plan.turnLookup, "selectBufferedTurn");
  assert.equal(plan.applyRollback, "commitRollbackState");
  assert.equal(plan.omitModule, "objectWithoutKeys");
  assert.equal(plan.startTurn, "launchBufferedTurn");
  assert.match(plan.evidenceHash, /^[a-f0-9]{64}$/);
  assert.ok(plan.offsets.turnLookup < plan.offsets.interrupt);
  assert.ok(plan.offsets.interrupt < plan.offsets.reacquireConversation);
  assert.ok(plan.offsets.reacquireConversation < plan.offsets.applyRollback);
  assert.ok(plan.offsets.applyRollback < plan.offsets.omitAndStartTurn);

  const patched = patchAppMainRetryCommands(source, plan);
  assert.match(
    patched,
    /"codexpatch-retry-turn-for-host":commandFactory\(async/
  );
  assert.match(patched, /selectBufferedTurn\(e\.getConversation\(t\),n\)/);
  assert.match(patched, /commitRollbackState\(e,\{conversationId:t/);
  assert.match(patched, /\(0,objectWithoutKeys\.default\)\(i\.params/);
  assert.match(patched, /await launchBufferedTurn\(e,t,/);
  assert.match(patched, /codexpatch:v4:webview-auto-retry-message-command/);
  assert.equal(countOccurrences(patched, RETRY_HANDLER_KEY), 1);
  assert.ok(patched.includes(source.slice(plan.handlerKeyOffset)));
});

test("resolves a current-shaped handler with reordered destructuring", () => {
  const source = makeRetryHandler({
    wrapper: "bindCommand",
    manager: "host",
    conversationId: "conversationRef",
    turnId: "turnRef",
    model: "modelRef",
    turnLookup: "lookupByTurn",
    applyRollback: "applyConversationRollback",
    omitModule: "omitProperties",
    startTurn: "startConversationTurn",
    fields: "turnId:turnRef, conversationId:conversationRef, model:modelRef",
    beforeInterrupt:
      "let effort=activeTurn.params.effort??initialState?.latestReasoningEffort??null;" +
      "if(activeTurn.status!==`inProgress`){await host.updateThreadSettingsForNextTurn(conversationRef,{effort,model:modelRef});return}"
  });

  const plan = resolveWebviewRetryPlan(source);
  assert.deepEqual(
    {
      wrapper: plan.commandWrapper,
      lookup: plan.turnLookup,
      rollback: plan.applyRollback,
      omit: plan.omitModule,
      start: plan.startTurn
    },
    {
      wrapper: "bindCommand",
      lookup: "lookupByTurn",
      rollback: "applyConversationRollback",
      omit: "omitProperties",
      start: "startConversationTurn"
    }
  );
});

test("fails closed when retry handler evidence is ambiguous", () => {
  const handler = makeRetryHandler();
  const result = inspectWebviewRetryPlan(`${handler},${handler}`);

  assert.equal(result.state, "AMBIGUOUS");
  assert.match(result.error, /retry handler key count is 2/);
});

test("fails closed when a retry semantic role is missing", async (t) => {
  const source = makeRetryHandler();
  const cases = [
    ["turn lookup", "findBufferedTurn(initialState,turnKey)", "host.findBufferedTurn(initialState,turnKey)"],
    ["interrupt", "host.interruptConversation(threadKey)", "host.cancelConversation(threadKey)"],
    ["rollback", "applyRollback(host,{", "host.applyRollback(host,{"],
    ["omit", "(0,omitKeys.default)(activeTurn.params", "omitKeys.default(activeTurn.params"],
    ["start turn", "await startTurn(host,threadKey", "await host.startTurn(host,threadKey"]
  ];

  for (const [name, needle, replacement] of cases) {
    await t.test(name, () => {
      const result = inspectWebviewRetryPlan(source.replace(needle, replacement));
      assert.equal(result.state, "MISSING");
      assert.match(result.error, /HookPoint\[webview-retry-command\]/);
    });
  }
});

test("ignores decoy role evidence outside the retry handler", () => {
  const decoy =
    "let x=outside.getConversation(y),z=fakeLookup(x,q);" +
    "outside.interruptConversation(y);let a=outside.getConversation(y);" +
    "fakeRollback(outside,{conversationId:y,conversationState:a,rollbackResponse:await outside.sendRequest(`thread/rollback`,{threadId:y,numTurns:1})});";
  const plan = resolveWebviewRetryPlan(`${decoy}${makeRetryHandler()}${decoy}`);

  assert.equal(plan.state, "FOUND");
  assert.equal(plan.turnLookup, "findBufferedTurn");
  assert.equal(plan.applyRollback, "applyRollback");
});

test("bounds retry handler scanning across nested syntax", () => {
  const syntax =
    'const nested={value:{text:"brace } and escaped \\" quote"}},' +
    "template=`ignored } ${String({value:1}.value)}`,pattern=/[}]/g;" +
    "/* ignored { } */";
  const source = makeRetryHandler({ bodyPrefix: syntax });
  const plan = resolveWebviewRetryPlan(source);

  assert.equal(plan.state, "FOUND");
  assert.ok(plan.offsets.bodyEnd > plan.offsets.omitAndStartTurn);
});

test("contains no retry symbol profile table", () => {
  const cliSource = fs.readFileSync(
    path.join(__dirname, "..", "bin", "vscodexkit.js"),
    "utf8"
  );

  assert.doesNotMatch(cliSource, /turnLookup:\s*"Wi"/);
  assert.doesNotMatch(cliSource, /turnLookup:\s*"un"/);
  assert.doesNotMatch(cliSource, /APP_MAIN_CURRENT_RETRY_SIGNATURE/);
});

function makeExtensionFixture(t) {
  const extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), "vscodexkit-test-"));
  fs.mkdirSync(path.join(extensionDir, "webview", "assets"), { recursive: true });
  t.after(() => fs.rmSync(extensionDir, { recursive: true, force: true }));
  return extensionDir;
}

function makeRetryHandler(options = {}) {
  const {
    wrapper = "wrapCommand",
    manager = "host",
    conversationId = "threadKey",
    turnId = "turnKey",
    model = "modelKey",
    turnLookup = "findBufferedTurn",
    applyRollback = "applyRollback",
    omitModule = "omitKeys",
    startTurn = "startTurn",
    fields = `conversationId:${conversationId},turnId:${turnId},model:${model}`,
    bodyPrefix = "",
    beforeInterrupt = ""
  } = options;
  return (
    `${RETRY_HANDLER_KEY}:${wrapper}(async(${manager},{${fields}})=>{` +
    `${bodyPrefix}let initialState=${manager}.getConversation(${conversationId}),` +
    `activeTurn=${turnLookup}(initialState,${turnId});` +
    "if(activeTurn==null)throw Error(`Buffered turn not found.`);" +
    beforeInterrupt +
    `if(await ${manager}.interruptConversation(${conversationId})!==activeTurn.turnId)` +
    "throw Error(`The buffered turn is no longer active.`);" +
    `const refreshedState=${manager}.getConversation(${conversationId});` +
    "if(refreshedState==null)throw Error(`Conversation state not found.`);" +
    `${applyRollback}(${manager},{conversationId:${conversationId},` +
    `conversationState:refreshedState,rollbackResponse:await ${manager}.sendRequest(` +
    `\`thread/rollback\`,{threadId:${conversationId},numTurns:1})});` +
    `let cleanParams=(0,${omitModule}.default)(activeTurn.params,` +
    "[`clientUserMessageId`,`threadId`]);" +
    `await ${startTurn}(${manager},${conversationId},{...cleanParams,` +
    `model:${model},inheritThreadSettings:false})})`
  );
}

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}
