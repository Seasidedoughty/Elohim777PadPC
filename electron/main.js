const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile, spawn, execSync } = require("child_process");

app.commandLine.appendSwitch("disable-hid-blocklist");

const BUTTONS = [
  "cross", "circle", "square", "triangle",
  "l1", "r1", "l2", "r2", "l3", "r3",
  "share", "options", "ps", "touch",
  "up", "down", "left", "right",
];

const VK = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0d, Escape: 0x1b, Space: 0x20,
  PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Insert: 0x2d, Delete: 0x2e,
  Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34,
  Digit5: 0x35, Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39,
  KeyA: 0x41, KeyB: 0x42, KeyC: 0x43, KeyD: 0x44, KeyE: 0x45, KeyF: 0x46,
  KeyG: 0x47, KeyH: 0x48, KeyI: 0x49, KeyJ: 0x4a, KeyK: 0x4b, KeyL: 0x4c,
  KeyM: 0x4d, KeyN: 0x4e, KeyO: 0x4f, KeyP: 0x50, KeyQ: 0x51, KeyR: 0x52,
  KeyS: 0x53, KeyT: 0x54, KeyU: 0x55, KeyV: 0x56, KeyW: 0x57, KeyX: 0x58,
  KeyY: 0x59, KeyZ: 0x5a,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
  ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3,
  AltLeft: 0xa4, AltRight: 0xa5, MetaLeft: 0x5b, MetaRight: 0x5c,
};

function keyAction(code) {
  return { type: "key", code: code };
}
function mouseAction(button) {
  return { type: "mouse", button: button };
}

function defaultProfile() {
  return {
    touchMouse: true,
    tapClick: true,
    stickMouse: false,
    sensitivity: 0.85,
    stickSpeed: 16,
    deadzone: 0.18,
    map: {
      cross: mouseAction("left"),
      circle: mouseAction("right"),
      square: { type: "none" },
      triangle: { type: "none" },
      l1: { type: "scroll", dir: -1 },
      r1: { type: "scroll", dir: 1 },
      l2: { type: "none" },
      r2: { type: "none" },
      l3: { type: "none" },
      r3: { type: "none" },
      share: keyAction("Escape"),
      options: keyAction("Enter"),
      ps: { type: "none" },
      touch: mouseAction("left"),
      up: keyAction("ArrowUp"),
      down: keyAction("ArrowDown"),
      left: keyAction("ArrowLeft"),
      right: keyAction("ArrowRight"),
    },
  };
}

const profile = { current: null };
let profilePath = "";

function loadProfile() {
  profilePath = path.join(app.getPath("userData"), "profile.json");
  try {
    const saved = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    profile.current = Object.assign(defaultProfile(), saved);
    profile.current.map = Object.assign(defaultProfile().map, saved.map || {});
  } catch (e) {
    profile.current = defaultProfile();
  }
}

function saveProfile(next) {
  const base = defaultProfile();
  profile.current = Object.assign(base, next || {});
  profile.current.map = Object.assign(base.map, (next && next.map) || {});
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(profile.current));
  return profile.current;
}

let mouseEvent = null;
let keybdEvent = null;
const held = {};
let prevTouch = { active: false, x: 0, y: 0 };
let touchOrigin = 0;
let touchTravel = 0;
let fracX = 0;
let fracY = 0;
let lastScroll = 0;

function bindInput() {
  if (process.platform !== "win32" || mouseEvent) return;
  const koffi = require("koffi");
  const user32 = koffi.load("user32.dll");
  mouseEvent = user32.func("void __stdcall mouse_event(uint32 flags, int32 dx, int32 dy, int32 data, uintptr extra)");
  keybdEvent = user32.func("void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)");
}

function moveCursor(dx, dy) {
  if (!mouseEvent) return;
  fracX += dx;
  fracY += dy;
  const ix = Math.trunc(fracX);
  const iy = Math.trunc(fracY);
  if (!ix && !iy) return;
  fracX -= ix;
  fracY -= iy;
  mouseEvent(1, ix, iy, 0, 0);
}

function mouseButton(button, down) {
  if (!mouseEvent) return;
  const flags = { left: [0x02, 0x04], right: [0x08, 0x10], middle: [0x20, 0x40] }[button];
  if (!flags) return;
  mouseEvent(down ? flags[0] : flags[1], 0, 0, 0, 0);
}

function clickLeft() {
  mouseButton("left", true);
  mouseButton("left", false);
}

function scroll(dir) {
  if (!mouseEvent) return;
  const now = Date.now();
  if (now - lastScroll < 70) return;
  lastScroll = now;
  mouseEvent(0x0800, 0, 0, dir < 0 ? 120 : -120, 0);
}

function keyButton(code, down) {
  if (!keybdEvent) return;
  const vk = VK[code];
  if (!vk) return;
  keybdEvent(vk, 0, down ? 0 : 2, 0);
}

function releaseAll() {
  Object.keys(held).forEach((name) => {
    if (!held[name]) return;
    applyEdge(name, false);
  });
}

function applyEdge(name, down) {
  const action = profile.current.map[name] || { type: "none" };
  const was = !!held[name];
  if (down === was) {
    if (down && action.type === "scroll") scroll(action.dir || 1);
    return;
  }
  held[name] = down;
  if (action.type === "mouse") mouseButton(action.button || "left", down);
  else if (action.type === "key") keyButton(action.code, down);
  else if (down && action.type === "scroll") scroll(action.dir || 1);
}

function applyFrame(frame) {
  if (!frame || !frame.buttons) return;
  bindInput();
  BUTTONS.forEach((name) => applyEdge(name, !!frame.buttons[name]));

  const touch = frame.touch;
  if (profile.current.touchMouse && touch && typeof touch.x === "number") {
    if (touch.active && prevTouch.active) {
      const dx = (touch.x - prevTouch.x) * Number(profile.current.sensitivity || 0.85);
      const dy = (touch.y - prevTouch.y) * Number(profile.current.sensitivity || 0.85);
      if (Math.abs(touch.x - prevTouch.x) < 500 && Math.abs(touch.y - prevTouch.y) < 500) {
        moveCursor(dx, dy);
        touchTravel += Math.abs(dx) + Math.abs(dy);
      }
    }
    if (touch.active && !prevTouch.active) {
      touchOrigin = Date.now();
      touchTravel = 0;
    }
    if (!touch.active && prevTouch.active && profile.current.tapClick) {
      if (Date.now() - touchOrigin < 220 && touchTravel < 28) clickLeft();
    }
    prevTouch = { active: !!touch.active, x: touch.x || 0, y: touch.y || 0 };
  } else {
    prevTouch = { active: false, x: 0, y: 0 };
  }

  if (profile.current.stickMouse && frame.sticks) {
    const dz = Number(profile.current.deadzone || 0.18);
    const speed = Number(profile.current.stickSpeed || 16);
    let lx = frame.sticks.lx || 0;
    let ly = frame.sticks.ly || 0;
    if (Math.abs(lx) < dz) lx = 0;
    if (Math.abs(ly) < dz) ly = 0;
    if (lx || ly) moveCursor(lx * speed, ly * speed);
  }
}

function isAdmin() {
  if (process.platform !== "win32") return false;
  try {
    execSync("net session", { stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

function bluetoothInfo() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve({ radio: [], pads: [], note: "Bluetooth pairing is a Windows feature." });
      return;
    }
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$radio = @(Get-PnpDevice -Class Bluetooth | Select-Object -First 8 Status,FriendlyName,InstanceId)",
      "$pads = @(Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -match 'Wireless Controller|DualShock|DualSense|Xbox|Game|Controller' } | Select-Object -First 12 Status,Class,FriendlyName,InstanceId)",
      "$obj = [pscustomobject]@{ radio = $radio; pads = $pads }",
      "$obj | ConvertTo-Json -Depth 4 -Compress",
    ].join("; ");
    execFile("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 12000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) {
        resolve({ radio: [], pads: [], note: "Windows did not return a Bluetooth list." });
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);
        resolve({ radio: list(data.radio), pads: list(data.pads) });
      } catch (e) {
        resolve({ radio: [], pads: [], note: "Could not read the Bluetooth list." });
      }
    });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#140e0c",
    autoHideMenuBar: true,
    title: "ELOHIM 777 PAD",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "app", "index.html"));
}

app.whenReady().then(() => {
  loadProfile();
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((_wc, permission) => permission === "hid");
  ses.setDevicePermissionHandler((details) => details.deviceType === "hid");
  ses.on("select-hid-device", (event, details, callback) => {
    event.preventDefault();
    const list = details.deviceList || [];
    if (!list.length) {
      callback("");
      return;
    }
    const sony = list.find((device) => device.vendorId === 0x054c);
    callback((sony || list[0]).deviceId);
  });
  createWindow();
});

app.on("window-all-closed", () => {
  releaseAll();
  app.quit();
});

ipcMain.on("pad-frame", (_event, frame) => applyFrame(frame));
ipcMain.handle("profile-get", () => profile.current);
ipcMain.handle("profile-set", (_event, next) => saveProfile(next));
ipcMain.handle("bluetooth-info", () => bluetoothInfo());
ipcMain.handle("is-admin", () => isAdmin());
ipcMain.handle("open-bluetooth", () => {
  shell.openExternal("ms-settings:bluetooth");
  return true;
});
ipcMain.handle("elevate", () => {
  if (process.platform !== "win32") return false;
  spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Process -FilePath '" + process.execPath.replace(/'/g, "''") + "' -Verb RunAs"], {
    detached: true,
    stdio: "ignore",
  }).unref();
  app.quit();
  return true;
});
