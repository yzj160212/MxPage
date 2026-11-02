const path = require("node:path");
const fs = require("node:fs");
const allowedTools = new Set(["doctor", "control_status", "discover_applications", "get_frontmost_app", "list_windows", "get_window", "screenshot", "get_ui_tree", "get_focused_element", "find_element", "list_menu_bar", "get_app_capabilities", "open_application", "activate_app", "activate_window", "resize_window", "set_target", "click", "left_click", "double_click", "right_click", "scroll", "type", "key", "click_element", "set_value", "press_button", "select_menu_item"]);
const observations = new Set(["screenshot", "get_ui_tree", "get_focused_element", "find_element", "list_menu_bar"]);
const reads = new Set(["doctor", "control_status", "discover_applications", "get_frontmost_app", "list_windows", "get_window", "screenshot", "get_ui_tree", "get_focused_element", "find_element", "list_menu_bar", "get_app_capabilities"]);
const forbiddenApps = /(?:^|[.\\/])(cmd|powershell|pwsh|bash|zsh|terminal|iterm2?|windowsterminal|osascript)(?:[.\\/]|$)/i;
function normalized(value) { return String(value || "").trim().toLowerCase().replace(/\.exe$/, ""); }
// Resolve symlinks before comparing so a link inside an approved directory cannot
// point at a file outside of it. Non-existent paths keep their lexical resolution.
function canonical(input) {
  const resolved = path.resolve(input);
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch { /* Path does not exist yet. */ }
  return process.platform === "win32" ? real.toLowerCase() : real;
}
function appAllowed(grant, value) { return Boolean(value) && !forbiddenApps.test(value) && grant.plan.applications.some(app => normalized(app) === normalized(value)); }
function checkPaths(grant, value) {
  if (value && typeof value === "object") { for (const item of Object.values(value)) checkPaths(grant, item); return; }
  if (typeof value !== "string") return;
  // Explicit paths supplied to UI tools must stay in approved directories. GUI
  // applications still run in the real user's session; this is not OS isolation.
  if (!path.isAbsolute(value)) return;
  const resolved = canonical(value);
  if (!grant.plan.directories.some(dir => { const root = canonical(dir); return resolved === root || resolved.startsWith(root + path.sep); })) throw new Error("文件路径超出批准的目录范围。");
}
function validateCall(grant, name, args) {
  if (!grant || grant.stopped) throw new Error("本机操作尚未授权或已停止。");
  if (!allowedTools.has(name)) throw new Error("桌面工具不在允许列表中。");
  if (args.force || args.full_screen || args.clear === true && name === "set_target" || args.focus_strategy && args.focus_strategy !== "strict") throw new Error("不能绕过用户接管、目标窗口或截图范围检查。");
  for (const field of ["bundle_id", "target_app", "app"]) if (args[field] && !appAllowed(grant, args[field])) throw new Error("目标应用不在批准范围。");
  for (const value of Object.values(args)) checkPaths(grant, value);
  if (name === "key" && /(?:win|meta|super|command|cmd)\s*\+\s*(?:r|space|tab|q)|alt\s*\+\s*(?:tab|f4)|ctrl\s*\+\s*esc/i.test(args.text || "")) throw new Error("不允许切换到系统命令入口或关闭应用的全局快捷键。");
  if (name === "open_application" && !/^[a-zA-Z0-9._-]+$/.test(args.bundle_id || "")) throw new Error("打开应用只接受已批准的应用 ID，不能附带命令或参数。");
  return { mutates: !reads.has(name), observes: observations.has(name) };
}
module.exports = { allowedTools, observations, reads, appAllowed, validateCall };
