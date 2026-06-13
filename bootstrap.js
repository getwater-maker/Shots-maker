/**
 * bootstrap.js — Electron 엔트리 (package.json main).
 * 캐시 디렉토리 분리 후 main.js 로딩.
 */
const path = require('path');
const os = require('os');
const { app } = require('electron');

// PrimingFlow(~/.flow-app)와 캐시/세션 충돌 방지 — 전용 디렉토리
try {
  const dataDir = path.join(os.homedir(), '.shots-maker');
  app.setPath('userData', path.join(dataDir, 'electron'));
} catch (_) {}

require('./main.js');
