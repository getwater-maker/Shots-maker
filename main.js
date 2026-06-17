/**
 * main.js — Electron 메인 프로세스. 창 생성 + IPC 오케스트레이션.
 * 권위 데이터(Project 인스턴스)는 여기 메모리(S)에 보유, 렌더러로는 DTO만 전달.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const P = require('./core/pipeline');

// 로컬 이미지/영상 미리보기용 커스텀 프로토콜 (app ready 전에 등록 필요)
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

let win = null;
const S = { parsed: null, scriptPath: null, outRoot: null, preset: null, ttsMgr: null, flowEng: null, abort: false };

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 860,
    title: 'Shots-maker',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#faf6f0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

function _mimeOf(p) {
  const e = path.extname(p).toLowerCase();
  return ({ '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mpga': 'audio/mpeg' })[e] || 'application/octet-stream';
}

app.whenReady().then(() => {
  // media://<encoded-abs-path> → 로컬 파일. Range 직접 처리(비디오 스트리밍 — net.fetch(file://)는 Range에서 ERR_UNEXPECTED).
  protocol.handle('media', (request) => {
    let p = decodeURIComponent(request.url.slice('media://'.length)).replace(/^\/+/, '');
    try {
      const stat = fs.statSync(p);
      const mime = _mimeOf(p);
      const range = request.headers.get('Range');
      const m = range && /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
        const len = end - start + 1;
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        fs.closeSync(fd);
        return new Response(buf, { status: 206, headers: {
          'Content-Type': mime, 'Content-Length': String(len),
          'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes',
        } });
      }
      return new Response(fs.readFileSync(p), { status: 200, headers: {
        'Content-Type': mime, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes',
      } });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // 자동 업데이트는 bootstrap.js 의 auto-updater 모듈이 담당 (PrimingFlow 방식)
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  try { if (S.flowEng && S.flowEng.context) S.flowEng.context.close(); } catch {}
});

const log = (line) => { if (win && !win.isDestroyed()) win.webContents.send('log', String(line)); };

ipcMain.handle('list-presets', () => {
  try { return P.listPresets(); } catch (e) { return []; }
});
ipcMain.handle('list-styles', () => {
  try { return require('./core/style-store').loadAll().map((s) => ({ id: s.id, name: s.name })); }
  catch (e) { return []; }
});

ipcMain.handle('open-script', async (_e, args = {}) => {
  const preset = P.getPreset(args.presetName || null);
  const opt = { properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md'] }] };
  if (preset && preset.scriptFolder && fs.existsSync(preset.scriptFolder)) opt.defaultPath = preset.scriptFolder;
  const r = await dialog.showOpenDialog(win, opt);
  if (r.canceled || !r.filePaths[0]) return null;
  const scriptPath = r.filePaths[0];
  S.scriptPath = scriptPath;
  S.parsed = P.parseScript(scriptPath);
  S.outRoot = computeOutRoot(scriptPath, preset);
  ensureDirs(S.outRoot); // media/tts/subtitles 먼저 생성
  log(`대본 열기: ${S.parsed.fileTitle}`);
  log(`편수 ${S.parsed.projects.length} · 출력 ${S.outRoot}`);
  return { dto: P.toDTO(S.parsed), scriptPath, outRoot: S.outRoot };
});

// 출력 경로 = <채널 outputFolder>/<대본파일명(확장자 제외)>/
//   그 안에 media/(이미지+영상) · tts/(음성) · subtitles/(SRT) 하위폴더 + 쇼츠N.vrew.
//   Windows 금지문자만 제거(대괄호·공백은 유지).
function _safeFolder(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}
function computeOutRoot(scriptPath, preset) {
  const folder = _safeFolder(path.basename(scriptPath).replace(/\.md$/i, ''));
  const outBase = (preset && preset.outputFolder) ? preset.outputFolder : path.join(__dirname, 'output');
  return path.join(outBase, folder);
}
// 쇼츠별 폴더: media-N(이미지+영상) · tts-N(음성) · subtitles-N(SRT). 루트에 쇼츠N.vrew.
function shortsDirs(outRoot, n) {
  const d = { media: path.join(outRoot, `media-${n}`), tts: path.join(outRoot, `tts-${n}`), subtitles: path.join(outRoot, `subtitles-${n}`) };
  for (const k of Object.keys(d)) { try { fs.mkdirSync(d[k], { recursive: true }); } catch {} }
  return d;
}
function ensureDirs(outRoot) {
  try { fs.mkdirSync(outRoot, { recursive: true }); } catch {}
  if (S.parsed) for (const pr of S.parsed.projects) shortsDirs(outRoot, pr.shortsNum);
}

ipcMain.handle('tts-build', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum = null, dry = false, presetName = null } = args;
  const { speed = null } = args;
  S.abort = false;
  if (!dry) {
    S.preset = P.getPreset(presetName);
    if (!S.preset) throw new Error('프리셋을 찾을 수 없습니다.');
    if (speed != null && speed !== '') S.preset = { ...S.preset, speed: Number(speed) };
    log(`프리셋 "${S.preset.name}" (${S.preset.engine}, 속도 ${S.preset.speed}x) 연결 중…`);
    const { mgr, ok } = await P.makeTtsManager(log, S.preset.engine);
    if (!ok) throw new Error(`TTS 엔진 '${S.preset.engine}' 미가동 (백엔드 확인)`);
    S.ttsMgr = mgr;
  }

  for (const pr of S.parsed.projects) {
    if (shortsNum && pr.shortsNum !== shortsNum) continue;
    const ttsDir = shortsDirs(S.outRoot, pr.shortsNum).tts;
    if (S.abort) { log('⏹ 중단됨'); break; }
    if (dry) { P.fillSilent(pr, ttsDir); log(`✓ 쇼츠${pr.shortsNum} 무음 오디오`); }
    else { await P.fillTts(pr, S.preset, S.ttsMgr, ttsDir, log, () => S.abort); log(`✓ 쇼츠${pr.shortsNum} 음성 완료`); }
  }
  return P.toDTO(S.parsed);
});

ipcMain.handle('export-vrew', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum = null, presetName = null, captionStyle = null, captionMaxChars = 7 } = args;
  try { fs.mkdirSync(S.outRoot, { recursive: true }); } catch {}
  let preset = S.preset || P.getPreset(presetName);
  if (preset && captionStyle) {
    preset = { ...preset, captionStyle: { ...(preset.captionStyle || {}), ...captionStyle } };
  }
  const outs = [];
  for (const pr of S.parsed.projects) {
    if (shortsNum && pr.shortsNum !== shortsNum) continue;
    const dirs = shortsDirs(S.outRoot, pr.shortsNum);
    const vrewPath = path.join(S.outRoot, `쇼츠${pr.shortsNum}.vrew`);
    try {
      const res = await P.buildProjectVrew(pr, vrewPath, preset, log, captionMaxChars);
      P.writeSrt(pr, path.join(dirs.subtitles, `쇼츠${pr.shortsNum}.srt`), captionMaxChars);
      outs.push({ shortsNum: pr.shortsNum, vrewPath, clipCount: res.clipCount, imageCount: res.imageCount });
      log(`✓ 쇼츠${pr.shortsNum}.vrew (clip ${res.clipCount}, image ${res.imageCount})`);
      shell.openPath(vrewPath); // 생성 즉시 Vrew로 열어 바로 렌더 가능
    } catch (e) {
      log(`✗ 쇼츠${pr.shortsNum} 실패: ${e.message}`);
    }
  }
  return { outRoot: S.outRoot, outs };
});

// Flow 이미지 — FlowAutomator는 win(IPC send)이 필요해 main에서 처리.
// customPrompts에 group.imagePrompt를 그대로 넣어 번역 없이 사용.
// Flow는 임시폴더에 생성 → 결과를 쇼츠N_images/cutM.ext 로 복사 (Genspark와 동일 위치, _flow 폴더 안 만듦).
// 크롬 프로필 정리 — stale 락 제거 + 복원 프롬프트 억제(비정상 종료 후 about:blank 창 누적 방지)
function cleanChromeProfile(profileDir) {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(profileDir, f), { force: true }); } catch {}
  }
  for (const sub of ['Default', '']) {
    try {
      const pref = path.join(profileDir, sub, 'Preferences');
      if (fs.existsSync(pref)) {
        const j = JSON.parse(fs.readFileSync(pref, 'utf8'));
        j.profile = j.profile || {};
        j.profile.exit_type = 'Normal';
        j.profile.exited_cleanly = true;
        fs.writeFileSync(pref, JSON.stringify(j));
      }
    } catch {}
  }
}

async function runFlowImages(project, imagesDir, logger, stylePrompt) {
  fs.mkdirSync(imagesDir, { recursive: true });
  const workDir = path.join(os.tmpdir(), `sm_flow_${project.shortsNum}_${Date.now().toString(36)}`);
  fs.mkdirSync(workDir, { recursive: true });
  const profileDir = path.join(os.homedir(), '.flow-app', 'profiles', 'default');
  fs.mkdirSync(profileDir, { recursive: true });
  // FlowAutomator 단일 인스턴스 재사용 — 매번 new 하면 같은 프로필에 크롬창이 중복 실행됨.
  // run()이 내부적으로 기존 브라우저 health-check 후 재사용함.
  if (!S.flowEng) {
    cleanChromeProfile(profileDir); // 첫 실행 시 stale 락/복원프롬프트 정리
    const { FlowAutomator } = require('./flow-engine');
    S.flowEng = new FlowAutomator(win, profileDir);
  }
  const eng = S.flowEng;
  const pfx = stylePrompt ? `${stylePrompt}, ` : ''; // 스타일 먼저(PrimingFlow 방식)
  const paragraphs = project.groups.map((g) => (project.getSentencesOfGroup(g)[0] || {}).text || `cut${g.num}`);
  const customPrompts = project.groups.map((g) => pfx + (g.imagePrompt || ''));
  const imgDir = path.join(workDir, 'images');
  // 생성 중 폴더를 폴링 → 새 이미지가 나타나면 즉시 그룹에 붙이고 화면 실시간 갱신.
  const poll = setInterval(() => {
    const n = mapFlowImagesOnce(project, imgDir, imagesDir, false);
    if (n > 0) pushDtoUpdate();
  }, 2500);
  try {
    await eng.run({
      paragraphs, customPrompts, mediaType: 'image',
      ratio: project.aspect || '9:16', outputDir: workDir,
      withSubtitle: false, vrewOnly: false,
      antiDetect: { enabled: true, preset: '기본' }, profileId: 'default',
    });
  } finally {
    clearInterval(poll);
  }
  // 최종 매핑(순서 폴백 포함) + 화면 갱신
  const total = mapFlowImagesOnce(project, imgDir, imagesDir, true, logger);
  logger(`[Flow] 이미지 매핑 완료 ${total}/${project.groups.length}`);
  pushDtoUpdate();
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
}

// 워크폴더 이미지 → media-N/NN.ext 로 매핑 (이미 매핑된 그룹은 건너뜀, 멱등). 신규 매핑 수 반환.
function mapFlowImagesOnce(project, imgDir, mediaDir, allowOrder, logger) {
  let files = [];
  try { files = fs.readdirSync(imgDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort(); } catch { return 0; }
  let n = 0;
  project.groups.forEach((g, i) => {
    if (g.imagePath && g.imagePath.startsWith(mediaDir) && fs.existsSync(g.imagePath)) return; // 이미 매핑됨
    const num = String(i + 1).padStart(2, '0');
    let f = files.find((x) => x.startsWith(num));
    if (!f && allowOrder) f = files[i];
    if (!f) return;
    const ext = path.extname(f).toLowerCase().replace('.jpeg', '.jpg');
    const dest = path.join(mediaDir, `${String(g.num).padStart(2, '0')}${ext}`);
    try { fs.copyFileSync(path.join(imgDir, f), dest); g.imagePath = dest; g.imageStatus = 'done'; n++; if (logger) logger(`[Flow] G${g.num} 이미지 첨부`); }
    catch (e) { if (logger) logger(`이미지 복사 실패 G${g.num}: ${e.message}`); }
  });
  return n;
}
function pushDtoUpdate() {
  try { if (win && !win.isDestroyed() && S.parsed) win.webContents.send('dto-update', P.toDTO(S.parsed)); } catch {}
}

ipcMain.handle('image-build', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum = null, engine = 'genspark', styleId = null } = args;
  S.abort = false;
  const stylePrompt = styleId ? (require('./core/style-store').getPrompt(styleId) || '') : '';
  for (const pr of S.parsed.projects) {
    if (shortsNum && pr.shortsNum !== shortsNum) continue;
    if (S.abort) { log('⏹ 중단됨'); break; }
    log(`🖼 쇼츠${pr.shortsNum} 이미지 생성 (${engine}${styleId ? ', 스타일=' + styleId : ''})…`);
    try {
      const mediaDir = shortsDirs(S.outRoot, pr.shortsNum).media;
      if (engine === 'flow') {
        await runFlowImages(pr, mediaDir, log, stylePrompt);
      } else {
        await P.generateImagesGenspark(pr, mediaDir, log, () => S.abort, stylePrompt, null, pushDtoUpdate);
      }
      log(`✓ 쇼츠${pr.shortsNum} 이미지 완료`);
    } catch (e) {
      log(`✗ 쇼츠${pr.shortsNum} 이미지 실패: ${e.message}`);
    }
    pushDtoUpdate(); // 생성된 이미지(g.imagePath)를 UI 썸네일에 즉시 반영
  }
  return P.toDTO(S.parsed);
});

// 영상 개수 결정 — 'random'/빈값이면 쇼츠마다 1~min(3,그룹수) 무작위, 숫자면 그 값.
function resolveVideoCount(raw, groupCount) {
  if (raw == null || raw === 'random' || raw === '' || isNaN(Number(raw))) {
    const max = Math.max(1, Math.min(3, groupCount));
    return 1 + Math.floor(Math.random() * max);
  }
  return Math.max(0, parseInt(raw, 10));
}

ipcMain.handle('video-build', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum = null, videoCount = 'random' } = args;
  S.abort = false;
  for (const pr of S.parsed.projects) {
    if (shortsNum && pr.shortsNum !== shortsNum) continue;
    if (S.abort) { log('⏹ 중단됨'); break; }
    const vc = resolveVideoCount(videoCount, pr.groups.length);
    log(`🎬 쇼츠${pr.shortsNum} 영상 ${vc}개 생성 (Grok)…`);
    try {
      const videoDir = shortsDirs(S.outRoot, pr.shortsNum).media; // 영상도 media-N 폴더
      await P.generateHookVideosGrok(pr, videoDir, log, () => S.abort, vc, pushDtoUpdate);
      log(`✓ 쇼츠${pr.shortsNum} 영상 완료`);
    } catch (e) {
      log(`✗ 쇼츠${pr.shortsNum} 영상 실패: ${e.message}`);
    }
    pushDtoUpdate(); // 생성된 영상(g.videoPath)을 UI 썸네일에 즉시 반영
  }
  return P.toDTO(S.parsed);
});

// 그룹에 이미지/비디오 직접 첨부 (썸네일 클릭 → 파일 선택)
ipcMain.handle('attach-asset', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum, groupNum } = args;
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: '이미지/비디오', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm', 'm4v'] }],
  });
  if (r.canceled || !r.filePaths[0]) return P.toDTO(S.parsed);
  const fp = r.filePaths[0];
  const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
  const g = pr && pr.groups.find((x) => x.num === groupNum);
  if (!g) return P.toDTO(S.parsed);
  const ext = path.extname(fp).toLowerCase();
  if (['.mp4', '.mov', '.webm', '.m4v'].includes(ext)) {
    g.videoPath = fp; g.videoStatus = 'done';
    log(`첨부(영상) ${pr.title} G${groupNum}: ${path.basename(fp)}`);
  } else {
    g.imagePath = fp; g.imageStatus = 'done';
    log(`첨부(이미지) ${pr.title} G${groupNum}: ${path.basename(fp)}`);
  }
  return P.toDTO(S.parsed);
});

// 그룹 첨부 자산 삭제 (이미지/비디오 비우기)
ipcMain.handle('clear-asset', (_e, args = {}) => {
  if (!S.parsed) return null;
  const { shortsNum, groupNum } = args;
  const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
  const g = pr && pr.groups.find((x) => x.num === groupNum);
  if (g) {
    g.imagePath = null; g.videoPath = null; g.imageStatus = 'idle'; g.videoStatus = 'idle'; g.videoSourceImage = null;
    log(`자산 삭제: ${pr.title} G${groupNum}`);
  }
  return P.toDTO(S.parsed);
});

// 채널(프리셋) 편집
ipcMain.handle('get-preset-detail', (_e, name) => {
  const all = require('./tts/preset-store').loadAll();
  return all.find((p) => p.name === name) || null;
});
ipcMain.handle('save-preset', (_e, args = {}) => {
  const store = require('./tts/preset-store');
  const p = store.loadAll().find((x) => x.name === args.name);
  if (!p) throw new Error('프리셋을 찾을 수 없습니다.');
  store.update(p.id, args.patch || {});
  log(`채널 "${args.name}" 설정 저장`);
  return store.loadAll().map((x) => ({ name: x.name, engine: x.engine, isDefault: !!x.isDefault }));
});
// Gemini API 키 (secret-store, gemini 엔진 공용) — GPU 없는 PC에서 음성 생성용
ipcMain.handle('get-gemini-key', () => {
  try { const s = require('./tts/secret-store').get('gemini'); return (s && s.key) || ''; } catch { return ''; }
});
ipcMain.handle('set-gemini-key', (_e, key) => {
  try { require('./tts/secret-store').set('gemini', { key: String(key || '').trim() }); log('Gemini API 키 저장됨'); return true; }
  catch (e) { log('Gemini 키 저장 실패: ' + e.message); return false; }
});

ipcMain.handle('pick-file', async (_e, args = {}) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: args.filters || [{ name: 'All', extensions: ['*'] }] });
  return (r.canceled || !r.filePaths[0]) ? null : r.filePaths[0];
});
ipcMain.handle('pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return (r.canceled || !r.filePaths[0]) ? null : r.filePaths[0];
});

// 일괄 첨부 — 이미지/영상 파일들을 직접 다중선택. 파일명 앞 숫자 = 그룹번호 매핑. 같은 번호면 영상 우선.
ipcMain.handle('bulk-attach', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum } = args;
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '이미지/영상', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm', 'm4v'] }],
  });
  if (r.canceled || !r.filePaths.length) return P.toDTO(S.parsed);
  const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
  if (!pr) return P.toDTO(S.parsed);
  const picked = r.filePaths; // 절대경로들
  const baseOf = (f) => path.basename(f);
  const isVid = (f) => /\.(mp4|mov|webm|m4v)$/i.test(f);
  const isImg = (f) => /\.(png|jpe?g|webp|gif)$/i.test(f);
  let cnt = 0;
  for (const g of pr.groups) {
    const matches = picked.filter((f) => {
      const mm = baseOf(f).match(/^0*(\d+)/);
      return mm && parseInt(mm[1], 10) === g.num && (isVid(f) || isImg(f));
    });
    if (!matches.length) continue;
    const vid = matches.find(isVid);
    const img = matches.find(isImg);
    if (vid) { g.videoPath = vid; g.videoStatus = 'done'; cnt++; }
    else if (img) { g.imagePath = img; g.imageStatus = 'done'; cnt++; }
  }
  log(`일괄첨부 ${pr.title}: 선택 ${picked.length}개 → ${cnt}개 그룹 매핑 (영상우선)`);
  return P.toDTO(S.parsed);
});

// 프로젝트 저장/불러오기 (대본 1개 기준 스냅샷)
ipcMain.handle('save-project', async () => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const projDir = path.join(os.homedir(), '.shots-maker', 'projects');
  fs.mkdirSync(projDir, { recursive: true });
  const base = P.sanitize(path.basename(S.scriptPath || 'project').replace(/\.md$/i, ''));
  const file = path.join(projDir, base + '.smproj.json');
  const snap = {
    scriptPath: S.scriptPath, fileTitle: S.parsed.fileTitle, meta: S.parsed.meta, outRoot: S.outRoot,
    projects: S.parsed.projects.map((pr) => ({
      shortsNum: pr.shortsNum, title: pr.title, aspect: pr.aspect, hookCaption: pr.hookCaption, voice: pr.voice,
      titleLine1: pr.titleLine1, titleLine2: pr.titleLine2,
      t1Size: pr.t1Size, t1Color: pr.t1Color, t1Align: pr.t1Align,
      t2Size: pr.t2Size, t2Color: pr.t2Color, t2Align: pr.t2Align,
      bgEnabled: pr.bgEnabled, bgFill: pr.bgFill, bgFillOp: pr.bgFillOp, bgStroke: pr.bgStroke,
      bgStrokeOp: pr.bgStrokeOp, bgStrokeW: pr.bgStrokeW, bgRound: pr.bgRound, bgDashed: pr.bgDashed,
      groups: pr.groups.map((g) => ({
        num: g.num, phase: g.phase, mode: g.mode, isI2V: g.isI2V,
        imagePrompt: g.imagePrompt, videoPrompt: g.videoPrompt, motionNote: g.motionNote,
        imagePath: g.imagePath, videoPath: g.videoPath,
        sentences: pr.getSentencesOfGroup(g).map((s) => ({ text: s.text, ttsAudioPath: s.ttsAudioPath, ttsDurationSec: s.ttsDurationSec })),
      })),
    })),
  };
  fs.writeFileSync(file, JSON.stringify(snap, null, 2), 'utf8');
  log(`💾 프로젝트 저장: ${file}`);
  return { file };
});
ipcMain.handle('load-project', async () => {
  const projDir = path.join(os.homedir(), '.shots-maker', 'projects');
  fs.mkdirSync(projDir, { recursive: true });
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], defaultPath: projDir, filters: [{ name: 'Shots 프로젝트', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const snap = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
  const { Sentence, Group, Project, makeSentenceIder, finalizeGroupIds } = require('./core/project-model');
  const projects = (snap.projects || []).map((ps) => {
    const sid = makeSentenceIder(); const sentences = []; const groups = [];
    (ps.groups || []).forEach((gs) => {
      const g = new Group({ num: gs.num, sentenceIds: [] });
      Object.assign(g, { imagePrompt: gs.imagePrompt, videoPrompt: gs.videoPrompt, phase: gs.phase, title: gs.phase, mode: gs.mode, isI2V: gs.isI2V, motionNote: gs.motionNote, imagePath: gs.imagePath, videoPath: gs.videoPath });
      (gs.sentences || []).forEach((ss) => {
        const s = new Sentence({ id: sid(ss.text), num: sentences.length + 1, text: ss.text });
        s.groupId = g.id; s.ttsAudioPath = ss.ttsAudioPath || null; s.ttsDurationSec = ss.ttsDurationSec || null;
        g.sentenceIds.push(s.id); sentences.push(s);
      });
      groups.push(g);
    });
    finalizeGroupIds(groups, sentences);
    const proj = new Project({ sentences, groups });
    Object.assign(proj, { aspect: ps.aspect, title: ps.title, shortsNum: ps.shortsNum, hookCaption: ps.hookCaption, voice: ps.voice,
      titleLine1: ps.titleLine1, titleLine2: ps.titleLine2,
      t1Size: ps.t1Size, t1Color: ps.t1Color, t1Align: ps.t1Align, t2Size: ps.t2Size, t2Color: ps.t2Color, t2Align: ps.t2Align,
      bgEnabled: ps.bgEnabled, bgFill: ps.bgFill, bgFillOp: ps.bgFillOp, bgStroke: ps.bgStroke,
      bgStrokeOp: ps.bgStrokeOp, bgStrokeW: ps.bgStrokeW, bgRound: ps.bgRound, bgDashed: ps.bgDashed });
    return proj;
  });
  S.scriptPath = snap.scriptPath; S.outRoot = snap.outRoot;
  S.parsed = { fileTitle: snap.fileTitle, meta: snap.meta, projects, format: 'grouped' };
  log(`📂 프로젝트 불러오기: ${r.filePaths[0]}`);
  return { dto: P.toDTO(S.parsed), scriptPath: S.scriptPath, outRoot: S.outRoot };
});

// ⚡ 전체 만들기 — TTS + 이미지 동시 → I2V 영상 → .vrew → 출력폴더 열기
ipcMain.handle('make-all', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum = null, engine = 'genspark', presetName = null, speed = null, captionStyle = null, captionMaxChars = 7, styleId = null, videoCount = 'random', dry = false } = args;
  const stylePrompt = styleId ? (require('./core/style-store').getPrompt(styleId) || '') : '';
  let preset = P.getPreset(presetName);
  if (preset && speed != null && speed !== '') preset = { ...preset, speed: Number(speed) };
  S.preset = preset;
  let ttsMgr = null;
  if (!dry && preset) {
    const { mgr, ok } = await P.makeTtsManager(log, preset.engine);
    if (!ok) throw new Error(`TTS 엔진 '${preset.engine}' 미가동`);
    ttsMgr = mgr;
  }
  S.abort = false;
  try { fs.mkdirSync(S.outRoot, { recursive: true }); } catch {}
  for (const pr of S.parsed.projects) {
    if (shortsNum && pr.shortsNum !== shortsNum) continue;
    if (S.abort) { log('⏹ 중단됨'); break; }
    const dirs = shortsDirs(S.outRoot, pr.shortsNum);
    log(`⚡ ${pr.title} 전체 제작 시작…`);
    const audioTask = dry ? Promise.resolve().then(() => P.fillSilent(pr, dirs.tts))
      : P.fillTts(pr, preset, ttsMgr, dirs.tts, log, () => S.abort);
    const imgTask = (engine === 'flow') ? runFlowImages(pr, dirs.media, log, stylePrompt)
      : P.generateImagesGenspark(pr, dirs.media, log, () => S.abort, stylePrompt, null, pushDtoUpdate);
    await Promise.allSettled([audioTask, imgTask]);
    pushDtoUpdate(); // TTS·이미지 매핑(g.imagePath) 결과를 UI 썸네일에 즉시 반영
    if (S.abort) { log('⏹ 중단됨'); break; }
    try { await P.generateHookVideosGrok(pr, dirs.media, log, () => S.abort, resolveVideoCount(videoCount, pr.groups.length), pushDtoUpdate); }
    catch (e) { log(`영상 실패: ${e.message}`); }
    pushDtoUpdate(); // 생성된 영상(g.videoPath)도 UI 에 반영
    let ep = preset;
    if (ep && captionStyle) ep = { ...ep, captionStyle: { ...(ep.captionStyle || {}), ...captionStyle } };
    const vrewPath = path.join(S.outRoot, `쇼츠${pr.shortsNum}.vrew`);
    try {
      const res = await P.buildProjectVrew(pr, vrewPath, ep, log, captionMaxChars);
      P.writeSrt(pr, path.join(dirs.subtitles, `쇼츠${pr.shortsNum}.srt`), captionMaxChars);
      log(`✓ ${pr.title}.vrew (clip ${res.clipCount})`);
      shell.openPath(vrewPath);
    } catch (e) { log(`vrew 실패: ${e.message}`); }
  }
  if (ttsMgr) { try { await ttsMgr.stop(); } catch {} }
  fs.mkdirSync(S.outRoot, { recursive: true });
  shell.openPath(S.outRoot);
  log('⚡ 전체 제작 완료 — 출력폴더 열림');
  return P.toDTO(S.parsed);
});

const TITLE_FIELDS = new Set(['titleLine1', 'titleLine2', 't1Size', 't1Color', 't1Align', 't2Size', 't2Color', 't2Align',
  'bgEnabled', 'bgFill', 'bgFillOp', 'bgStroke', 'bgStrokeOp', 'bgStrokeW', 'bgRound', 'bgDashed']);
ipcMain.handle('set-title', (_e, args = {}) => {
  if (!S.parsed) return;
  const { shortsNum, field, value } = args;
  if (!TITLE_FIELDS.has(field)) return;
  const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
  if (pr) pr[field] = value;
});

// 미리보기 오디오 — 파일을 base64 data URL 로 반환 (media:// fetch 가 렌더러에서 막히는 경우 우회)
// 작업 중단 — generate 함수들의 abortSignal 이 S.abort 를 확인
ipcMain.handle('abort', () => { S.abort = true; log('⏹ 중단 요청 — 현재 단계 마치는 대로 멈춥니다'); });

// 초기화 — 새 대본 작업을 위해 현재 상태 비움
ipcMain.handle('reset-project', () => {
  S.parsed = null; S.scriptPath = null; S.outRoot = null; S.preset = null; S.abort = false;
  log('🆕 초기화 — 새 대본을 여세요');
  return true;
});

// 빈(또는 특정) 그룹 1개만 이미지 재생성 (Genspark 단일)
ipcMain.handle('regen-group', async (_e, args = {}) => {
  if (!S.parsed) throw new Error('대본을 먼저 여세요.');
  const { shortsNum, groupNum, styleId = null } = args;
  const pr = S.parsed.projects.find((p) => p.shortsNum === shortsNum);
  const g = pr && pr.groups.find((x) => x.num === groupNum);
  if (!g) return P.toDTO(S.parsed);
  if (!g.imagePrompt || !g.imagePrompt.trim()) { log(`G${groupNum}: 이미지 프롬프트 없음`); return P.toDTO(S.parsed); }
  S.abort = false;
  const stylePrompt = styleId ? (require('./core/style-store').getPrompt(styleId) || '') : '';
  const mediaDir = shortsDirs(S.outRoot, shortsNum).media;
  log(`🔄 쇼츠${shortsNum} G${groupNum} 이미지 재생성 (Genspark)…`);
  try {
    await P.generateImagesGenspark(pr, mediaDir, log, () => S.abort, stylePrompt, [groupNum], pushDtoUpdate);
    log(`✓ G${groupNum} 재생성 완료`);
  } catch (e) { log(`✗ G${groupNum} 재생성 실패: ${e.message}`); }
  return P.toDTO(S.parsed);
});

ipcMain.handle('set-aspect', (_e, value) => {
  if (!S.parsed) return null;
  const a = (value === '1:1') ? '1:1' : '9:16';
  for (const pr of S.parsed.projects) pr.aspect = a;
  log(`이미지/영상 비율 → ${a}`);
  return P.toDTO(S.parsed);
});

ipcMain.handle('read-audio', (_e, p) => {
  try {
    const buf = fs.readFileSync(p);
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.wav' ? 'audio/wav' : (ext === '.mp3' || ext === '.mpga' || ext === '.mpeg') ? 'audio/mpeg' : 'application/octet-stream';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
});

ipcMain.handle('open-folder', async () => {
  if (!S.outRoot) return;
  fs.mkdirSync(S.outRoot, { recursive: true });
  shell.openPath(S.outRoot);
});
