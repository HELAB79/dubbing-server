// server.js
// 이 서버가 하는 일: 영상 파일 + 녹음 파일을 받아서, FFmpeg로 소리를 바꿔치기한 새 영상을 만들어 돌려줍니다.

const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const app = express();
app.use(cors());
// 사용자가 보낸 파일을 임시로 저장할 곳 (uploads 폴더가 없으면 자동으로 생깁니다)
const upload = multer({ dest: 'uploads/' });

// 결과 영상을 저장할 폴더 (없으면 자동으로 만듭니다)
if (!fs.existsSync('outputs')) fs.mkdirSync('outputs');

// 서버가 잘 켜졌는지 확인용 페이지
app.get('/', (req, res) => {
  res.send('서버가 잘 실행되고 있어요!');
});

// 진짜 작업이 일어나는 부분: /combine 이라는 주소로 영상+녹음을 보내면 합쳐서 돌려줍니다
app.post('/combine', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), (req, res) => {
  if (!req.files || !req.files['video'] || !req.files['audio']) {
    return res.status(400).send('영상과 녹음 파일을 둘 다 보내주세요.');
  }

  const videoPath = req.files['video'][0].path;
  const audioPath = req.files['audio'][0].path;
  const outputFileName = `combined_${Date.now()}.mp4`;
  const outputPath = path.join('outputs', outputFileName);

  // FFmpeg한테 내리는 명령: "영상 파일의 화면은 그대로 쓰고, 소리만 녹음 파일 걸로 바꿔줘"
  const ffmpegArgs = [
    '-i', videoPath,      // 첫 번째 입력: 원본 영상
    '-i', audioPath,      // 두 번째 입력: 내 녹음 파일
    '-map', '0:v:0',      // 화면은 첫 번째 파일(원본 영상)에서 가져옴
    '-map', '1:a:0',      // 소리는 두 번째 파일(내 녹음)에서 가져옴
    '-c:v', 'copy',       // 화면은 다시 인코딩하지 않고 그대로 복사 (속도 빠름, 화질 손실 없음)
    '-shortest',          // 둘 중 더 짧은 길이에 맞춰서 자름
    outputPath
  ];

  execFile('ffmpeg', ffmpegArgs, (error) => {
    // 작업이 끝났으니 임시로 받아둔 파일은 정리합니다
    fs.unlink(videoPath, () => {});
    fs.unlink(audioPath, () => {});

    if (error) {
      console.error('FFmpeg 에러:', error);
      return res.status(500).send('영상 합성에 실패했어요.');
    }
    // 완성된 파일을 사용자에게 다운로드로 돌려줍니다
    res.download(path.resolve(outputPath), outputFileName);
  });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
