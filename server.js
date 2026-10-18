// server.js  (Render 배포용 · 더빙 영상 합성 서버)
//
// 이 서버가 하는 일
//   앱이 보내준 "원본 영상 + 내 녹음"을 받아서, FFmpeg로 합친 새 영상(mp4)을 돌려줍니다.
//   - 내가 연기한 대사 구간에서는 원래 목소리를 끄고 내 목소리를 넣습니다.
//   - 다른 캐릭터 대사 구간에서는 원래 소리를 그대로 살려둡니다.
//
// 앱도 이 서버에서 열 수 있어요
//   https://(이 서버 주소)/en  → 영어학습판,   /ko → 한국어학습판
//   (휴대폰에서 파일을 직접 열면 마이크 허용 팝업이 뜨지 않아서, https 주소로 열어야 녹음이 됩니다)
//
// 이전 버전에서 고친 점
//   1) cors()        : 앱이 다른 주소에서 열려 있어도 이 서버를 부를 수 있게 허용
//   2) ffmpeg-static : Render 서버에는 ffmpeg가 없어서, ffmpeg를 함께 설치해서 사용
//   3) 소리 위치 맞춤  : 녹음이 시작된 시점(offset)과 내 대사 구간(mute)을 받아서 정확한 자리에 합침
//   4) PORT          : Render가 정해준 포트로 실행

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.set('trust proxy', true);          // Render 같은 서버 앞단을 거쳐도 접속자 주소를 바르게 읽도록
app.use(cors());

// 업로드 파일을 임시로 두는 곳 (서버가 재시작되면 사라지는 임시 폴더)
const TMP_DIR = path.join(os.tmpdir(), 'dubbing');
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR, limits: { fileSize: 80 * 1024 * 1024 } });

// 첫 화면: 앱 바로가기 (앱이 미리 한 번 불러서 서버를 깨우는 데도 씁니다)
const LANDING = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>씬 스피크 · Scene Speak</title>
<style>body{font-family:system-ui,-apple-system,'Noto Sans KR',sans-serif;max-width:420px;margin:48px auto;padding:0 20px;color:#17151F}
a.btn{display:block;padding:18px;margin:14px 0;border-radius:14px;background:#FFC93C;color:#17151F;text-decoration:none;font-weight:800;text-align:center;font-size:16px}
small{color:#777}</style></head><body><h2>씬 스피크 · Scene Speak</h2>
<a class="btn" href="/en">English 학습판 (한국인용)</a>
<a class="btn" href="/ko">한국어 학습판 (외국인용)</a>
<small>서버 상태: 정상 ✅ · 이 주소(https)로 열어야 마이크가 작동해요.</small></body></html>`;
app.get('/', (req, res) => res.type('html').send(LANDING));
app.get('/health', (req, res) => res.json({
  ok: true,
  ffmpeg: Boolean(ffmpegPath),
  evaluate: { groq: Boolean(GROQ_KEY), deepgram: Boolean(DG_KEY), order: String(process.env.EVAL_PROVIDER_ORDER || 'groq,deepgram') },
  apps: { en: fs.existsSync(path.join(__dirname, 'en.html')), ko: fs.existsSync(path.join(__dirname, 'ko.html')) }
}));

// 앱 파일 열기 (GitHub에 올린 en.html / ko.html)
function sendApp(fileName) {
  return (req, res) => {
    const file = path.join(__dirname, fileName);
    fs.access(file, err => {
      if (err) return res.status(404).type('text').send(`${fileName} 파일이 아직 서버에 없어요. GitHub 저장소에 올렸는지 확인해 주세요.`);
      res.set('Cache-Control', 'no-cache');     // 새로 올린 앱이 바로 반영되도록 매번 확인
      res.sendFile(file, { cacheControl: false });
    });
  };
}
app.get('/en', sendApp('en.html'));
app.get('/ko', sendApp('ko.html'));


// ============================================================
//  평가(받아쓰기) 기능 + 사용 횟수 제한
//  - 앱이 보낸 "내 녹음"을 음성 인식 서비스로 글자로 바꾸고, 단어별 시각과 함께 돌려줍니다.
//  - 순서: Groq(무료 플랜) → Deepgram(무료 크레딧). 카드를 등록하지 않았다면 한도가 끝났을 때 요금이 청구되지 않고 평가만 멈춥니다.
//  - 키는 코드에 쓰지 않고 Render의 Environment(환경변수)에만 넣습니다.
//
//  환경변수 (모두 선택. 없으면 아래 기본값)
//    GROQ_API_KEY / DEEPGRAM_API_KEY : 음성 인식 서비스 키 (둘 중 하나만 있어도 됨)
//    EVAL_DAILY_PER_USER   : 기기 1대가 하루에 받을 수 있는 평가 횟수 (기본 1, 테스터 기간엔 3 같은 숫자로)
//    EVAL_DAILY_TOTAL      : 모든 사용자 합쳐서 하루 평가 횟수 상한 (기본 300)
//    SAVE_DAILY_PER_USER   : 기기 1대가 하루에 영상을 저장(합성)할 수 있는 횟수 (기본 3)
//    EVAL_PROVIDER_ORDER   : 인식 서비스 순서 (기본 groq,deepgram). 비교해 볼 때는 deepgram,groq 로 바꾸면 Deepgram을 먼저 써요
//    EVAL_MAX_BYTES        : 평가에 보낼 수 있는 녹음 파일 크기 상한 (기본 2500000 = 약 2.5MB)
// ============================================================
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const DG_KEY = process.env.DEEPGRAM_API_KEY || '';
const GROQ_URL = process.env.GROQ_URL || 'https://api.groq.com/openai/v1/audio/transcriptions';
const DG_URL = process.env.DG_URL || 'https://api.deepgram.com/v1/listen';
const intEnv = (name, d) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n >= 0 ? n : d; };
const EVAL_DAILY_PER_USER = intEnv('EVAL_DAILY_PER_USER', 1);
const EVAL_DAILY_TOTAL = intEnv('EVAL_DAILY_TOTAL', 300);
const SAVE_DAILY_PER_USER = intEnv('SAVE_DAILY_PER_USER', 3);
const EVAL_MAX_BYTES = intEnv('EVAL_MAX_BYTES', 2500000);
const EVAL_IP_PER_HOUR = 30;

// 사용 기록 (하루 단위, 한국 시간 기준). 무료 서버가 재시작되면 초기화될 수 있어요 → 그래서 음성 인식 서비스 쪽 한도가 마지막 안전장치입니다.
const USAGE_FILE = path.join(os.tmpdir(), 'scenespeak-usage.json');
let usage = {};
try { usage = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')) || {}; } catch (e) { usage = {}; }
const kstDay = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
function usageGet(key) { return usage[key] || 0; }
function usageAdd(key, n) {
  usage[key] = Math.max(0, (usage[key] || 0) + n);
  const today = kstDay();
  Object.keys(usage).forEach(k => { if (!k.startsWith(today + '|')) delete usage[k]; });   // 지난 날 기록은 지움
  fs.writeFile(USAGE_FILE, JSON.stringify(usage), () => {});
}
const ukey = (kind, id) => `${kstDay()}|${kind}|${id}`;
const ipHits = new Map();   // 같은 주소에서 너무 자주 부르는 것 막기
function ipOk(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter(t => now - t < 3600 * 1000);
  if (arr.length >= EVAL_IP_PER_HOUR) { ipHits.set(ip, arr); return false; }
  arr.push(now); ipHits.set(ip, arr); return true;
}
function installId(req) {
  const v = String(req.get('x-install-id') || '');
  return /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : null;
}
function whoKey(req) { return installId(req) || ('ip-' + (req.ip || 'unknown')); }

const evalUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: EVAL_MAX_BYTES, files: 1 } });

async function transcribeGroq(buf, mime, lang) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'audio/webm' }), 'audio.webm');
  fd.append('model', 'whisper-large-v3-turbo');
  fd.append('language', lang);
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'word');
  fd.append('temperature', '0');
  const r = await fetch(GROQ_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + GROQ_KEY }, body: fd, signal: AbortSignal.timeout(45000) });
  if (!r.ok) { const e = new Error('groq ' + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  return (j.words || []).map(w => ({ w: String(w.word || '').trim(), s: Number(w.start), e: Number(w.end) })).filter(w => w.w && Number.isFinite(w.s));
}
async function transcribeDeepgram(buf, mime, lang) {
  const url = `${DG_URL}?model=nova-3&language=${encodeURIComponent(lang)}&punctuate=false&smart_format=false&mip_opt_out=true`;
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Token ' + DG_KEY, 'Content-Type': mime || 'audio/webm' }, body: buf, signal: AbortSignal.timeout(45000) });
  if (!r.ok) { const e = new Error('deepgram ' + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  const alt = j && j.results && j.results.channels && j.results.channels[0] && j.results.channels[0].alternatives && j.results.channels[0].alternatives[0];
  return ((alt && alt.words) || []).map(w => ({ w: String(w.word || '').trim(), s: Number(w.start), e: Number(w.end) })).filter(w => w.w && Number.isFinite(w.s));
}

// 이 기기가 오늘 평가를 몇 번 더 받을 수 있는지
app.get('/eval-status', (req, res) => {
  const who = whoKey(req);
  res.json({
    enabled: Boolean(GROQ_KEY || DG_KEY),
    limit: EVAL_DAILY_PER_USER,
    remaining: Math.max(0, EVAL_DAILY_PER_USER - usageGet(ukey('eval', who))),
    saveLimit: SAVE_DAILY_PER_USER,
    saveRemaining: Math.max(0, SAVE_DAILY_PER_USER - usageGet(ukey('save', who)))
  });
});

app.post('/evaluate', (req, res) => {
  evalUpload.single('audio')(req, res, async err => {
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'too-large' : 'bad-request' });
    if (!req.file || !req.file.buffer || !req.file.buffer.length) return res.status(400).json({ error: 'no-audio' });
    if (!(GROQ_KEY || DG_KEY)) return res.status(503).json({ error: 'unavailable' });
    const lang = req.body.lang === 'ko' ? 'ko' : 'en';
    const who = whoKey(req);
    if (!ipOk(req.ip || 'unknown')) return res.status(429).json({ error: 'busy' });

    const uk = ukey('eval', who), tk = ukey('eval', 'TOTAL');
    if (usageGet(uk) >= EVAL_DAILY_PER_USER) return res.status(429).json({ error: 'user-limit', limit: EVAL_DAILY_PER_USER, remaining: 0 });
    if (usageGet(tk) >= EVAL_DAILY_TOTAL) return res.status(429).json({ error: 'total-limit' });
    usageAdd(uk, 1); usageAdd(tk, 1);                       // 먼저 한 번 쓴 것으로 잡아 두고, 실패하면 돌려줘요

    const available = { groq: GROQ_KEY ? transcribeGroq : null, deepgram: DG_KEY ? transcribeDeepgram : null };
    const order = String(process.env.EVAL_PROVIDER_ORDER || 'groq,deepgram').split(',').map(s => s.trim().toLowerCase());
    ['groq', 'deepgram'].forEach(n => { if (!order.includes(n)) order.push(n); });
    const providers = order.filter(n => available[n]).map(n => [n, available[n]]);
    for (const [name, fn] of providers) {
      try {
        const words = await fn(req.file.buffer, req.file.mimetype, lang);
        console.log(`평가 완료: ${name} · ${lang} · ${req.file.buffer.length}바이트 · 단어 ${words.length}개`);
        return res.json({ ok: true, provider: name, words, remaining: Math.max(0, EVAL_DAILY_PER_USER - usageGet(uk)), limit: EVAL_DAILY_PER_USER });
      } catch (e) {
        console.error(`평가 실패(${name}):`, e.status || e.message);   // 한도·오류면 다음 서비스로 넘어가요
      }
    }
    usageAdd(uk, -1); usageAdd(tk, -1);                      // 모두 실패하면 횟수는 차감하지 않아요
    res.status(503).json({ error: 'unavailable' });
  });
});

// 영상 저장(합성)도 하루 횟수를 제한해요
function saveLimiter(req, res, next) {
  const k = ukey('save', whoKey(req));
  if (usageGet(k) >= SAVE_DAILY_PER_USER) {
    return res.status(429).type('text').send(`오늘 저장할 수 있는 횟수(${SAVE_DAILY_PER_USER}회)를 모두 사용했어요. 내일 다시 이용해 주세요.`);
  }
  usageAdd(k, 1);
  res.on('finish', () => { if (res.statusCode >= 400) usageAdd(k, -1); });   // 실패한 저장은 횟수에서 빼 줘요
  next();
}

function removeFiles(...files) {
  files.forEach(f => { if (f) fs.unlink(f, () => {}); });
}

// 숫자만 안전하게 꺼내기
function num(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

app.post('/combine', saveLimiter, upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), (req, res) => {
  if (!req.files || !req.files['video'] || !req.files['audio']) {
    return res.status(400).send('영상과 녹음 파일을 둘 다 보내주세요.');
  }

  const videoPath = req.files['video'][0].path;
  const audioPath = req.files['audio'][0].path;
  const outputPath = path.join(TMP_DIR, `combined_${Date.now()}_${Math.floor(Math.random() * 1e6)}.mp4`);

  // 녹음이 시작된 시점이 영상의 몇 초 지점인지 (앱이 계산해서 보내줌)
  const offset = Math.max(-10, Math.min(120, num(req.body.offset, 0)));

  // 내가 연기한 대사 구간들 [[시작, 끝], ...]  → 이 구간에서는 원래 목소리를 끕니다
  let mute = [];
  try {
    const parsed = JSON.parse(req.body.mute || '[]');
    if (Array.isArray(parsed)) {
      mute = parsed
        .filter(w => Array.isArray(w) && w.length === 2)
        .map(w => [num(w[0]), num(w[1])])
        .filter(w => w[1] > w[0])
        .slice(0, 200);
    }
  } catch (e) { mute = []; }

  // 1단계: 원본 영상에 소리가 들어 있는지 확인
  execFile(ffmpegPath, ['-hide_banner', '-i', videoPath], { maxBuffer: 10 * 1024 * 1024 }, (_probeErr, _out, probeLog) => {
    const hasOriginalAudio = /Audio:/.test(probeLog || '');

    // 내 녹음: 영상 속 맞는 위치에 오도록 offset만큼 뒤로 미룸 (음수면 앞부분을 잘라냄)
    let micChain;
    if (offset >= 0) {
      const ms = Math.round(offset * 1000);
      micChain = `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${ms}|${ms}[mic]`;
    } else {
      micChain = `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=start=${(-offset).toFixed(3)},asetpts=PTS-STARTPTS[mic]`;
    }

    let filter;
    if (hasOriginalAudio) {
      // 원래 소리: 내 대사 구간에서는 볼륨 0
      const gate = mute.length
        ? `,volume=enable='${mute.map(([s, e]) => `between(t,${s.toFixed(3)},${e.toFixed(3)})`).join('+')}':volume=0`
        : '';
      const origChain = `[0:a]aformat=sample_rates=44100:channel_layouts=stereo${gate}[orig]`;
      filter = `${origChain};${micChain};[orig][mic]amix=inputs=2:duration=first:dropout_transition=0,volume=2,alimiter=limit=0.95[aout]`;
    } else {
      filter = `${micChain};[mic]anull[aout]`;
    }

    const ffmpegArgs = [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-filter_complex', filter,
      '-map', '0:v:0',
      '-map', '[aout]',
      '-c:v', 'copy',          // 화면은 다시 만들지 않고 그대로 복사 (빠르고 화질 그대로)
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath
    ];
    if (!hasOriginalAudio) ffmpegArgs.splice(ffmpegArgs.indexOf('-movflags'), 0, '-shortest');

    execFile(ffmpegPath, ffmpegArgs, { maxBuffer: 20 * 1024 * 1024 }, (error, _stdout, stderr) => {
      removeFiles(videoPath, audioPath);

      if (error) {
        console.error('FFmpeg 에러:', stderr || error);
        removeFiles(outputPath);
        const tail = String(stderr || error.message || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
        return res.status(500).send('영상 합성에 실패했어요. ' + tail);
      }

      res.download(outputPath, 'my_dubbed_video.mp4', () => removeFiles(outputPath));
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`서버 실행 중: 포트 ${PORT}`);
});
