/**
 * pipeline.js — 대본 → TTS → .vrew 공유 파이프라인 (CLI build-shorts.js + Electron main.js 공용)
 *
 * 권위 있는 데이터(Project/Sentence/Group 인스턴스)는 호출자가 메모리에 보유하고,
 * 이 모듈의 함수들이 그 위에서 동작한다. 렌더러로는 toDTO()로 직렬화해 보낸다.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { parseCutScriptFile } = require('./cut-script-parser');
const { splitCaptionLines, meaningfulLen } = require('./caption-splitter');
const { buildVrew } = require('../vrew/vrew-builder');
const presetStore = require('../tts/preset-store');
const { getInstance: getTTS } = require('../tts/tts-manager');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch {}

// ── 파싱 ────────────────────────────────────────────────
function parseScript(scriptPath) {
  return parseCutScriptFile(scriptPath); // { fileTitle, meta, projects: Project[] }
}

/** Project[] → 렌더러용 직렬화 DTO */
function toDTO(parseResult) {
  const { fileTitle, meta, projects } = parseResult;
  return {
    fileTitle,
    meta,
    projects: projects.map((pr) => {
      let capN = 0; // 자막 줄 넘버링 — 그룹을 넘어 편 전체에서 이어짐
      return {
        shortsNum: pr.shortsNum,
        title: pr.title,
        aspect: pr.aspect,
        hookCaption: pr.hookCaption,
        titleLine1: pr.titleLine1 != null ? pr.titleLine1 : (pr.hookCaption || ''),
        titleLine2: pr.titleLine2 || '',
        t1Size: pr.t1Size || 120, t1Color: pr.t1Color || '#ffffff', t1Align: pr.t1Align || 'center',
        t2Size: pr.t2Size || 120, t2Color: pr.t2Color || '#ffe08a', t2Align: pr.t2Align || 'center',
        bgEnabled: !!pr.bgEnabled, bgFill: pr.bgFill || '#000000', bgFillOp: pr.bgFillOp != null ? pr.bgFillOp : 50,
        bgStroke: pr.bgStroke || '#000000', bgStrokeOp: pr.bgStrokeOp != null ? pr.bgStrokeOp : 0,
        bgStrokeW: pr.bgStrokeW || 0, bgRound: pr.bgRound || 0, bgDashed: !!pr.bgDashed,
        voice: pr.voice,
        cuts: pr.groups.map((g) => {
          const sents = pr.getSentencesOfGroup(g);
          return {
            num: g.num,
            phase: g.phase || null,
            mode: g.mode || (g.isI2V ? 'i2v' : 'motion'),
            isI2V: !!g.isI2V,
            sentences: sents.map((s) => ({
              text: s.text || '',
              dur: s.ttsDurationSec || null,
              audio: s.ttsAudioPath || null,
              // 브루 클립 단위(8자/쉼표) + 이어지는 넘버링
              lines: splitCaptionLines(s.text || '', 8).map((t) => ({ n: ++capN, text: t })),
            })),
            groupDurationSec: sents.reduce((a, s) => a + (s.ttsDurationSec || 0), 0) || null,
            imagePrompt: g.imagePrompt || '',
            videoPrompt: g.videoPrompt || '',
            motionNote: g.motionNote || '',
            imagePath: g.imagePath || null,
            videoPath: g.videoPath || null,
            imageStatus: g.imageStatus || null, // 'generating' | 'done' | 'fail'
            videoStatus: g.videoStatus || null, // 'generating' | 'done' | 'fail'
          };
        }),
      };
    }),
  };
}

// ── 프리셋 ──────────────────────────────────────────────
function getPreset(name) {
  const all = presetStore.loadAll();
  return name ? all.find((p) => p.name === name) || null : presetStore.getDefault();
}
function listPresets() {
  return presetStore.loadAll().map((p) => ({ name: p.name, engine: p.engine, isDefault: !!p.isDefault }));
}

// ── TTS 매니저 (연결 완료 보장) ──────────────────────────
async function makeTtsManager(logger, engine) {
  const mgr = getTTS({ logger: logger || (() => {}) });
  await mgr.start();
  // start()는 omnivoice/supertonic 연결을 await하지 않음 → refreshProvider로 완료 대기
  const ok = await mgr.refreshProvider(engine);
  return { mgr, ok };
}

// ── 오디오 채우기 ───────────────────────────────────────
async function fillTts(project, preset, ttsMgr, workDir, onLine, abortSignal) {
  fs.mkdirSync(workDir, { recursive: true });
  for (const s of project.sentences) {
    if (abortSignal && abortSignal()) { if (onLine) onLine('⏹ TTS 중단'); break; }
    const out = path.join(workDir, `${s.num}.wav`);
    const res = await ttsMgr.synthesize(s.text, {
      provider: preset.engine,
      refAudioPath: preset.voiceCloneRefAudio || undefined,
      refText: preset.voiceCloneRefText || undefined,
      instruct: preset.instruct || undefined,
      cfgValue: preset.cfgValue,
      inferenceTimesteps: preset.inferenceTimesteps,
      speed: preset.speed,
      language: preset.language,
      seed: preset.seed,
    });
    fs.writeFileSync(out, res.mp3Buffer);
    s.ttsAudioPath = out;
    s.ttsDurationSec = res.durationSec;
    if (onLine) onLine(`tts 쇼츠${project.shortsNum} 컷${s.num}: ${res.durationSec.toFixed(2)}s`);
  }
}

function makeSilentMp3(durSec, outPath) {
  if (!ffmpegPath) throw new Error('ffmpeg-static 미설치');
  const args = ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(durSec), '-acodec', 'libmp3lame', '-q:a', '9', outPath];
  const r = spawnSync(ffmpegPath, args, { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(outPath)) throw new Error('ffmpeg 무음 생성 실패');
}
function fillSilent(project, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  for (const s of project.sentences) {
    const dur = Math.min(6.5, Math.max(2.2, 1.0 + (s.charCount || 0) * 0.16));
    const mp3 = path.join(workDir, `${s.num}.mp3`);
    makeSilentMp3(dur, mp3);
    s.ttsAudioPath = mp3;
    s.ttsDurationSec = dur;
  }
}

// ── .vrew 내보내기 (편별) ───────────────────────────────
async function buildProjectVrew(project, vrewPath, preset, logger, captionMaxChars) {
  const opts = {
    aspect: project.aspect || '9:16',
    skipSelfCheck: true,            // 이미지 미연결 단계에서 누락을 에러로 막지 않음
    captionMaxChars: captionMaxChars || 7,
    logger: logger || (() => {}),
  };
  if (preset) {
    if (preset.captionStyle) opts.captionStyle = preset.captionStyle;
    if (preset.aiNotice && preset.aiNotice.enabled) opts.aiNotice = preset.aiNotice;
    if (preset.disableLongSplit != null) opts.disableLongSplit = preset.disableLongSplit;
  }
  // 제목(훅) 상단 고정 — 편별 titleLine1/2 + 줄별 스타일
  const l1 = project.titleLine1 != null ? project.titleLine1 : (project.hookCaption || '');
  const l2 = project.titleLine2 || '';
  if (l1 || l2) {
    opts.title = {
      line1: l1, line2: l2,
      l1: { size: project.t1Size || 120, color: project.t1Color || '#ffffff', align: project.t1Align || 'center' },
      l2: { size: project.t2Size || 120, color: project.t2Color || '#ffe08a', align: project.t2Align || 'center' },
    };
    // 제목 배경 도형
    if (project.bgEnabled) {
      opts.titleBg = {
        enabled: true,
        fillColor: project.bgFill || '#000000',
        fillOpacity: project.bgFillOp != null ? project.bgFillOp : 50,
        borderColor: project.bgStroke || '#000000',
        borderOpacity: project.bgStrokeOp != null ? project.bgStrokeOp : 0,
        borderWidth: project.bgStrokeW || 0,
        cornerRounding: project.bgRound || 0,
        dashed: !!project.bgDashed,
      };
    }
  }
  return buildVrew({ sentences: project.sentences, groups: project.groups, vrewPath, opts });
}

// ── 이미지 생성 ─────────────────────────────────────────
// group.imagePrompt 를 "그대로" 투입. 컷 num → cut{num}.png. 결과를 group.imagePath 에 매핑.
async function generateImagesGenspark(project, imagesDir, logger, abortSignal, stylePrompt, onlyNums, onProgress) {
  fs.mkdirSync(imagesDir, { recursive: true });
  const groups = project.groups;
  const idx = groups.map((g, i) => i).filter((i) => groups[i].imagePrompt && groups[i].imagePrompt.trim()
    && (!onlyNums || onlyNums.includes(groups[i].num)));
  if (!idx.length) { (logger || (() => {}))('이미지 프롬프트가 있는 컷이 없음'); return []; }

  // 대상 그룹을 '생성 중'으로 표시 → UI 즉시 반영 (사용자가 진행 상황을 바로 인지)
  idx.forEach((i) => { if (!groups[i].imagePath) groups[i].imageStatus = 'generating'; });
  if (onProgress) { try { onProgress(); } catch {} }

  const log = logger || (() => {});
  // PrimingFlow 방식: 스타일을 앞, 대본 이미지 프롬프트를 뒤에 둠.
  const pfx = stylePrompt ? `${stylePrompt}, ` : '';
  const prompts = idx.map((i) => pfx + groups[i].imagePrompt);
  const outputPaths = idx.map((i) => path.join(imagesDir, `${String(groups[i].num).padStart(2, '0')}.png`));

  const { GensparkEngine } = require('../genspark-engine');
  const eng = new GensparkEngine({ profileId: 'default', logger: log });
  eng._aspectRatio = project.aspect || '9:16'; // 9:16 비율 강제 (config ratio override)

  // Genspark 는 한 번 제출에 최대 6장 → 6개씩 묶어 배치 제출 (한 장씩 X).
  const BATCH = 6;
  const results = new Array(idx.length);
  try {
    for (let start = 0; start < idx.length; start += BATCH) {
      if (abortSignal && abortSignal()) break;
      const ps = prompts.slice(start, start + BATCH);
      const ops = outputPaths.slice(start, start + BATCH);
      log(`[Genspark] 배치 ${start / BATCH + 1}: ${ps.length}장 한 번에 제출`);
      // 저장되는 즉시 그룹에 매핑 → UI 갱신 (한 배치 안에서도 한 장씩 붙음)
      const onSaved = (k, p) => {
        const g = groups[idx[start + k]];
        if (g && p) { g.imagePath = p; g.imageStatus = 'done'; if (onProgress) { try { onProgress(); } catch {} } }
      };
      const r = await eng.generateImagesBatch({ prompts: ps, outputPaths: ops, abortSignal: abortSignal || (() => false), onSaved });
      for (let k = 0; k < ps.length; k++) results[start + k] = r[k];
    }
  } finally {
    try { await eng.stop(); } catch {}
  }

  results.forEach((r, k) => {
    const g = groups[idx[k]];
    if (r && r.path) { g.imagePath = r.path; g.imageStatus = 'done'; }
    else if (g.imageStatus === 'generating') { g.imageStatus = 'fail'; }
  });
  if (onProgress) { try { onProgress(); } catch {} }
  const ok = results.filter((r) => r && r.path).length;
  log(`이미지 ${ok}/${idx.length} 생성 (쇼츠${project.shortsNum})`);
  return results;
}

// 엔진 분기 (현재 genspark 구현, flow는 main.js에서 win 필요로 별도 처리)
async function generateImages(project, engine, imagesDir, logger, abortSignal) {
  if (engine === 'genspark') return generateImagesGenspark(project, imagesDir, logger, abortSignal);
  throw new Error(`이미지 엔진 '${engine}' 미지원(파이프라인) — flow는 main.js 경로`);
}

// ── 앞에서 N개 그룹 → Grok image-to-video (PrimingFlow 방식: 개수 지정) ──────────
// videoCount 만큼 앞 그룹부터 영상화. 모션 프롬프트 = group.videoPrompt(I2V) || group.motionNote || Grok 기본.
async function generateHookVideosGrok(project, videoDir, logger, abortSignal, videoCount, onProgress) {
  fs.mkdirSync(videoDir, { recursive: true });
  const log = logger || (() => {});
  const N = Math.max(0, parseInt(videoCount, 10) || 0);
  if (!N) { log('비디오 개수 0 — 생성 안 함'); return []; }
  const targets = project.groups.slice(0, N); // 앞에서 N개 그룹

  const { GrokEngine } = require('../grok-engine');
  const eng = new GrokEngine({ profileId: 'default', logger: log });
  eng._aspectRatio = project.aspect || '9:16'; // 이미지 비율(9:16/1:1)에 맞춰 영상 생성

  const results = [];
  try {
    for (const g of targets) {
      if (!g.imagePath || !fs.existsSync(g.imagePath)) {
        log(`그룹${g.num}: 이미지가 없어 영상 건너뜀 (먼저 이미지 생성 필요)`);
        results.push({ num: g.num, success: false, error: 'no image' });
        continue;
      }
      const outputPath = path.join(videoDir, `${String(g.num).padStart(2, '0')}.mp4`);
      g.videoStatus = 'generating';
      if (onProgress) { try { onProgress(); } catch {} } // '영상 변환 중' 배지 즉시 표시
      const res = await eng.generateVideoFromImage({
        imagePath: g.imagePath,
        prompt: g.videoPrompt || g.motionNote || g.videoMotionPrompt || null, // 없으면 Grok 기본 모션
        outputPath,
        abortSignal: abortSignal || (() => false),
      });
      if (res && res.success && res.videoPath) {
        g.videoPath = res.videoPath;
        g.videoSourceImage = g.imagePath;
        g.videoStatus = 'done';
        log(`✓ 그룹${g.num} 영상 생성${res.downgradedTo ? ` (${res.downgradedTo})` : ''}`);
      } else {
        g.videoStatus = 'fail';
        log(`✗ 그룹${g.num} 영상 실패: ${res && res.error}`);
      }
      results.push({ num: g.num, ...res });
      if (onProgress) { try { onProgress(); } catch {} } // 그룹별 영상 완성 시 UI 갱신
    }
  } finally {
    try { await eng.stop(); } catch {}
  }
  return results;
}

// ── 그룹 합치기 (TTS 시간 8초 미만 묶기) ────────────────
// TTS 변환 후 호출. 앞에서부터 연속 그룹을 누적해 합이 maxSec(8.0)을 넘지 않는 선까지 한 그룹으로 합침.
// 절대 maxSec 를 초과하지 않음(문장 단위라 정확히 8.0은 못 맞춰도 근처). 한 그룹이 이미 ≥maxSec 면 단독 유지.
// 합쳐진 그룹은 문장을 모두 합치고, 이미지/영상 프롬프트·경로는 비움(합친 뒤 내보내기/가져오기로 새로 만듦).
function mergeGroupsByTts(project, maxSec = 8.0) {
  const { Group, finalizeGroupIds } = require('./project-model');
  const groups = project.groups;
  if (!groups || groups.length < 2) return { before: groups ? groups.length : 0, after: groups ? groups.length : 0, merged: 0 };
  const durOf = (g) => project.getSentencesOfGroup(g).reduce((a, s) => a + (s.ttsDurationSec || 0), 0);

  const buckets = [];
  let cur = null, curDur = 0;
  for (const g of groups) {
    const d = durOf(g);
    if (cur && (curDur + d) <= maxSec + 1e-6) { cur.push(g); curDur += d; }
    else { cur = [g]; curDur = d; buckets.push(cur); }
  }

  const newGroups = buckets.map((bucket, i) => {
    const first = bucket[0];
    const ng = new Group({ num: i + 1, sentenceIds: bucket.flatMap((g) => g.sentenceIds) });
    ng.phase = first.phase || null;
    ng.title = first.title || null;
    ng.mode = first.mode || (first.isI2V ? 'i2v' : 'motion');
    ng.isI2V = !!first.isI2V;
    // 합친 뒤 새 프롬프트를 만들 것이므로 첫 그룹의 프롬프트만 임시 보존(없으면 null). 경로는 비움.
    ng.imagePrompt = bucket.map((g) => g.imagePrompt).find((p) => p && p.trim()) || null;
    ng.videoPrompt = bucket.map((g) => g.videoPrompt).find((p) => p && p.trim()) || null;
    ng.motionNote = bucket.map((g) => g.motionNote).find((p) => p && p.trim()) || null;
    return ng;
  });

  project.groups = newGroups;
  finalizeGroupIds(newGroups, project.sentences); // sentence.groupId 재지정 + 안정 id
  return { before: groups.length, after: newGroups.length, merged: groups.length - newGroups.length };
}

// ── SRT 자막 파일 (subtitles 폴더용) ────────────────────
function _fmtSrt(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}
function writeSrt(project, srtPath, maxChars = 7) {
  fs.mkdirSync(path.dirname(srtPath), { recursive: true });
  let t = 0, idx = 1, out = '';
  for (const g of project.groups) {
    for (const s of project.getSentencesOfGroup(g)) {
      const dur = s.ttsDurationSec || 2.5;
      const clips = splitCaptionLines(s.text, maxChars);
      const totW = clips.reduce((a, c) => a + Math.max(1, meaningfulLen(c)), 0) || 1;
      let acc = t;
      clips.forEach((c, i) => {
        const cd = dur * (Math.max(1, meaningfulLen(c)) / totW);
        const start = acc;
        const end = (i === clips.length - 1) ? t + dur : acc + cd;
        out += `${idx++}\n${_fmtSrt(start)} --> ${_fmtSrt(end)}\n${c}\n\n`;
        acc = end;
      });
      t += dur;
    }
  }
  try { fs.writeFileSync(srtPath, out, 'utf8'); } catch {}
}

// 파일명 안전화
function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

module.exports = {
  parseScript, toDTO, getPreset, listPresets,
  makeTtsManager, fillTts, fillSilent, buildProjectVrew, sanitize,
  generateImages, generateImagesGenspark, generateHookVideosGrok, writeSrt,
  mergeGroupsByTts,
};
