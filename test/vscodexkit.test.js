"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildAdbNotificationArgs,
  findWebviewAppMain,
  parseAdbDeviceSerials,
  patchAppMainAutoRetry,
  patchAppMainFollowerInterrupt,
  patchAppMainInterrupt,
  patchAppMainRetryCommands,
  patchNotificationRegistration
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

  assert.match(patched, /codexpatch:v21:retry-message-reuse/);
  assert.match(patched, /return connection\.registerInternalNotificationHandler\(notification=>/);
  assert.match(patched, /events\.emit\("turnComplete"\)/);
  assert.match(patched, /cpNotifyAdb\(h,g,u\)/);
  assert.match(patched, /kind:"retry",message:"Codex 正在自动重试"/);
  assert.match(patched, /if\(!e\.notified\)e\.notified=true,cpNotify/);
  assert.match(patched, /notify-skip-stale-completed-during-retry/);
  assert.match(patched, /cpRestartRetryRound\(e\)/);
  assert.match(patched, /if\(n===\"unknown\"\).*auto-retry-skip-output-boundary/);
  assert.match(patched, /a=n===\"absent\"\?\"rollback\"/);
  assert.match(patched, /\"edit-message\":\"message\"/);
  assert.doesNotMatch(patched, /return d\.registerInternalNotificationHandler\(Re=>/);
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
