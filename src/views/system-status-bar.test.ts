import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { renderFile } from "ejs";
import fs from "node:fs";

const partialPath = path.join(process.cwd(), "src/views/partials/system-status-bar.ejs");

function render(account: {
  authenticated: boolean;
  currentUserEmail: string | null;
  availableWorkspaceModuleCount: number;
  hideWorkspaceSwitch: boolean;
  isChildWindow?: boolean;
}) {
  return renderFile(partialPath, {
    appTitle: "RideMatrix",
    currentUserEmail: account.currentUserEmail,
    currentUserHref: "/account",
    systemStatusBar: account,
    csrfField: '<input type="hidden" name="_csrf" value="test-token">',
    isChildWindow: account.isChildWindow
  });
}

test("system status bar renders secure account actions for multiple workspaces", async () => {
  const html = await render({
    authenticated: true,
    currentUserEmail: "admin@example.com",
    availableWorkspaceModuleCount: 2,
    hideWorkspaceSwitch: false
  });

  assert.match(html, /class="system-status-bar__account-actions"/);
  assert.match(html, /href="\/choose-role">Switch workspace/);
  assert.match(html, /<form class="system-status-bar__account-action-form" method="post" action="\/exit">/);
  assert.match(html, /name="_csrf"/);
  assert.match(html, /type="submit">Exit/);
});

test("system status bar actions use the Administration CTA system", () => {
  const css = fs.readFileSync("public/css/app.css", "utf8");
  const accountAction = css.match(/\.system-status-bar__account-action \{([\s\S]*?)\n\}/)?.[1] ?? "";

  assert.match(accountAction, /min-height: var\(--rm-control-height\);/);
  assert.match(accountAction, /padding: var\(--rm-control-padding-block\) var\(--rm-control-padding-inline\);/);
  assert.match(accountAction, /border: var\(--rm-control-border-width\) solid var\(--rm-admin-cta-border\);/);
  assert.match(accountAction, /border-radius: var\(--rm-control-border-radius\);/);
  assert.match(accountAction, /background: var\(--rm-admin-cta-bg\);/);
  assert.match(accountAction, /color: var\(--rm-admin-cta-text\);/);
  assert.match(css, /\.system-status-bar__account-action--negative \{[\s\S]*border-bottom-color: var\(--rm-cta-negative-accent\);/);
  assert.match(css, /\.system-status-bar__account-action:focus-visible \{/);
  assert.doesNotMatch(accountAction, /var\(--rm-cta-helper-bg\)|var\(--rm-cta-negative-bg\)/);
});

test("system status bar hides workspace switch on choose-role and for one workspace", async () => {
  const chooseRoleHtml = await render({
    authenticated: true,
    currentUserEmail: "admin@example.com",
    availableWorkspaceModuleCount: 2,
    hideWorkspaceSwitch: true
  });
  const singleWorkspaceHtml = await render({
    authenticated: true,
    currentUserEmail: "staff@example.com",
    availableWorkspaceModuleCount: 1,
    hideWorkspaceSwitch: false
  });

  assert.doesNotMatch(chooseRoleHtml, /Switch workspace/);
  assert.doesNotMatch(singleWorkspaceHtml, /Switch workspace/);
  assert.match(chooseRoleHtml, /action="\/exit"/);
});

test("system status bar hides all account actions for public access", async () => {
  const html = await render({
    authenticated: false,
    currentUserEmail: null,
    availableWorkspaceModuleCount: 0,
    hideWorkspaceSwitch: false
  });

  assert.doesNotMatch(html, /Switch workspace|action="\/exit"/);
});

test("system status bar is not rendered in the explicit child-window layout", async () => {
  const html = await render({
    authenticated: true,
    currentUserEmail: "admin@example.com",
    availableWorkspaceModuleCount: 2,
    hideWorkspaceSwitch: false,
    isChildWindow: true
  });

  assert.equal(html.trim(), "");
});
