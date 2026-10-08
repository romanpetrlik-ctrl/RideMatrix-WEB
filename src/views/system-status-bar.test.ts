import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { renderFile } from "ejs";
import fs from "node:fs";

const partialPath = path.join(process.cwd(), "src/views/partials/system-status-bar.ejs");
const setupWizardPath = path.join(process.cwd(), "src/views/pages/setup/wizard.ejs");

function render(account: {
  authenticated: boolean;
  currentUserEmail: string | null;
  availableWorkspaceModuleCount: number;
  hideWorkspaceSwitch: boolean;
  isChildWindow?: boolean;
}, exitOptions: Record<string, string | boolean> = {}) {
  return renderFile(partialPath, {
    appTitle: "RideMatrix",
    currentUserEmail: account.currentUserEmail,
    currentUserHref: "/account",
    systemStatusBar: account,
    csrfField: '<input type="hidden" name="_csrf" value="test-token">',
    isChildWindow: account.isChildWindow,
    ...exitOptions
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
  assert.doesNotMatch(html, /Help \/ Recovery|href="\/recovery"/);
  assert.match(html, /href="\/choose-role">Switch workspace/);
  assert.match(html, /<form class="system-status-bar__account-action-form" method="post" action="\/exit">/);
  assert.match(html, /name="_csrf"/);
  assert.match(html, /type="submit">Exit/);
  assert.match(html, /button--admin-cta--negative system-status-bar__account-action/);
});

test("system status bar actions use the system CTA variant", () => {
  const css = fs.readFileSync("public/css/app.css", "utf8");
  const accountAction = css.match(/\.system-status-bar__account-action \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const partial = fs.readFileSync("src/views/partials/system-status-bar.ejs", "utf8");

  assert.match(partial, /class="button button--system-cta system-status-bar__account-action"/);
  assert.match(partial, /statusBarExitActionIsNegative \? "button--admin-cta--negative" : ""/);
  assert.doesNotMatch(partial, /button--admin-cta--dynamic|button--admin-cta--system/);
  assert.match(accountAction, /flex: 0 0 auto;/);
  assert.match(accountAction, /max-width: 100%;/);
  assert.match(accountAction, /white-space: nowrap;/);
  assert.match(css, /\.button--admin-cta,\s*\.button--dynamic-cta,\s*\.button--system-cta \{[\s\S]*min-height: var\(--rm-control-height\);/);
  assert.match(css, /\.button--system-cta \{[\s\S]*min-height: var\(--rm-cta-system-height\);/);
  assert.match(css, /\.button--admin-cta\.button--admin-cta--negative,\s*\.button--dynamic-cta\.button--admin-cta--negative,\s*\.button--system-cta\.button--admin-cta--negative \{[\s\S]*background: var\(--rm-admin-cta-negative-bg\);/);
});

test("setup exit action is explicit, CSRF-protected, and uses a non-destructive style", async () => {
  const html = await render({
    authenticated: true,
    currentUserEmail: "admin@example.com",
    availableWorkspaceModuleCount: 1,
    hideWorkspaceSwitch: false
  }, {
    exitActionPath: "/setup/exit",
    exitActionLabel: "Exit setup and return to sign-in",
    exitActionIsNegative: false
  });

  assert.match(html, /method="post" action="\/setup\/exit"/);
  assert.match(html, /name="_csrf"/);
  assert.match(html, /type="submit">Exit setup and return to sign-in<\/button>/);
  assert.doesNotMatch(html, /button--admin-cta--negative[^"]*system-status-bar__account-action/);
});

test("setup wizard renders its specific sign-in exit action", async () => {
  const html = await renderFile(setupWizardPath, {
    title: "Initial Setup",
    appTitle: "RideMatrix",
    email: "admin@example.com",
    currentPath: "/setup/bootstrap-superuser",
    requestedPath: "/setup/bootstrap-superuser",
    stepPaths: {
      bootstrap_superuser: "/setup/bootstrap-superuser",
      operator_profile: "/setup/operator-profile",
      registered_pho_address: "/setup/registered-pho-address",
      operational_address: "/setup/operational-address",
      pho_licence: "/setup/pho-licence",
      licence_document: "/setup/licence-document",
      review_confirmation: "/setup/review",
      completed: "/setup/completed"
    },
    notice: null,
    errors: [],
    formData: { installerEmail: "admin@example.com" },
    authorities: [],
    setup: {},
    setupAudit: [],
    cleanupTargets: [],
    csrfField: '<input type="hidden" name="_csrf" value="test-token">'
  });

  assert.match(html, /method="post" action="\/setup\/exit"/);
  assert.match(html, /type="submit">Exit setup and return to sign-in<\/button>/);
  assert.doesNotMatch(html, /button--admin-cta--negative[^"]*system-status-bar__account-action/);
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

  assert.doesNotMatch(html, /Help \/ Recovery|href="\/recovery"/);
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
