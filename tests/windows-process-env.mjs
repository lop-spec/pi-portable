import assert from "node:assert/strict";
import { forceMsysPseudoConsole, withSilentWindowsProcessEnv } from "../src/windows-process-env.mjs";

assert.equal(forceMsysPseudoConsole(undefined), "enable_pcon");
assert.equal(forceMsysPseudoConsole(""), "enable_pcon");
assert.equal(forceMsysPseudoConsole("winsymlinks:nativestrict"), "winsymlinks:nativestrict enable_pcon");
assert.equal(forceMsysPseudoConsole("disable_pcon winsymlinks:native enable_pcon"), "winsymlinks:native enable_pcon");
assert.equal(forceMsysPseudoConsole("ENABLE_PCON"), "enable_pcon");

const source = { Path: "C:/runtime", msys: "disable_pcon notransparent_exe" };
const windows = withSilentWindowsProcessEnv(source, "win32");
assert.deepEqual(windows, { Path: "C:/runtime", msys: "notransparent_exe enable_pcon" });
assert.notEqual(windows, source, "environment must be cloned");
assert.equal(source.msys, "disable_pcon notransparent_exe", "input environment must not be mutated");
assert.equal(Object.prototype.hasOwnProperty.call(windows, "MSYS"), false, "preserve existing environment key casing");

const linux = withSilentWindowsProcessEnv(source, "linux");
assert.deepEqual(linux, source);
assert.notEqual(linux, source);

console.log("PASS Windows MSYS ConPTY environment contract");
