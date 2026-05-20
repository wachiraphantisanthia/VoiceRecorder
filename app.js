// ตรวจสอบว่าเปิดจาก LINE บน Android หรือเปล่า
const ua = navigator.userAgent;
const isLine = /Line\//i.test(ua);
const isAndroid = /Android/i.test(ua);

// ถ้าใช่ → แสดง banner แนะนำให้เปิดใน Chrome
if (isLine && isAndroid) {
  document.getElementById('line-warn').style.display = 'block';
  const url = window.location.href;
  // Intent URL = deep link สำหรับเปิด Chrome โดยตรงบน Android
  const intentUrl =
    `intent://${window.location.host}${window.location.pathname}${window.location.search}` +
    `#Intent;scheme=https;package=com.android.chrome;` +
    `S.browser_fallback_url=${encodeURIComponent(url)};end`;
  document.getElementById('open-browser-btn').href = intentUrl;
}

// --- DOM elements ---
const btnRecord = document.getElementById('btn-record');    // ปุ่มไมค์
const btnStop   = document.getElementById('btn-stop');      // ปุ่มหยุด
const btnPlay   = document.getElementById('btn-play');      // ปุ่มเล่นเสียง
const btnReset  = document.getElementById('btn-reset');     // ปุ่มรีเซต
const statusEl  = document.getElementById('status');        // ข้อความสถานะ
const timerEl   = document.getElementById('timer');         // นาฬิกานับเวลา
const wrapEl    = document.getElementById('waveform-wrap'); // กรอบ waveform
const canvas    = document.getElementById('waveform');      // canvas วาด waveform
const ctx       = canvas.getContext('2d');
const pulseRing = document.getElementById('pulse-ring');    // วงแอนิเมชันรอบปุ่มไมค์
const errorEl   = document.getElementById('error-msg');     // กล่องแสดง error

// --- State ---
let mediaRecorder = null;  // ตัวบันทึกเสียง
let audioChunks   = [];    // เก็บข้อมูลเสียงเป็นชิ้นๆ ระหว่างบันทึก
let audioEl       = null;  // Audio object สำหรับเล่นเสียงที่บันทึกไว้
let timerInterval = null;  // interval สำหรับนับเวลา
let seconds       = 0;     // จำนวนวินาทีที่บันทึกไป
let animFrame     = null;  // requestAnimationFrame id สำหรับหยุด waveform
let analyser      = null;  // Web Audio analyser node (อ่านข้อมูลเสียง real-time)
let dataArray     = null;  // array เก็บค่าคลื่นเสียงแต่ละ frame
let mimeType      = '';    // mimeType ที่ browser รองรับ

// --- Helpers ---

// เปิด/ปิดปุ่ม
function setBtn(el, on) {
  el.disabled = !on;
}

// แปลงวินาที → "MM:SS"
function fmt(s) {
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

// เลือก mimeType ที่ browser รองรับ → iOS ใช้ mp4, อื่นๆ ใช้ webm
function getSupportedMimeType() {
  const types = ['audio/webm', 'audio/mp4', 'audio/ogg'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// วาด waveform ลง canvas ทุก frame ขณะบันทึก
function drawWave() {
  animFrame = requestAnimationFrame(drawWave); // เรียกตัวเองซ้ำทุก frame (~60fps)
  analyser.getByteTimeDomainData(dataArray);   // ดึงข้อมูลคลื่นเสียงปัจจุบัน
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  ctx.strokeStyle = '#e24b4a';
  ctx.lineWidth = 2;
  const sw = w / dataArray.length; // ความกว้างต่อ 1 sample
  let x = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const y = (dataArray[i] / 128) * h / 2; // แปลง 0-255 → ตำแหน่ง y บน canvas
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    x += sw;
  }
  ctx.stroke();
}

// SVG icon สำหรับปุ่มเล่น/หยุดเล่น
const ICON_PLAY  = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> เล่นเสียง';
const ICON_PAUSE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> หยุดเล่น';

// --- กดปุ่มไมค์: เริ่มบันทึก ---
btnRecord.addEventListener('click', async () => {
  errorEl.style.display = 'none';
  try {
    // ขอสิทธิ์เข้าถึงไมค์ → ได้ stream เสียงกลับมา
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // ต่อ stream เข้า Web Audio API เพื่อวิเคราะห์คลื่นเสียง real-time
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512; // ความละเอียดของการวิเคราะห์
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);

    // เลือก mimeType ที่ browser รองรับ (iOS → mp4, อื่นๆ → webm)
    mimeType = getSupportedMimeType();

    // สร้าง MediaRecorder พร้อม mimeType ที่เหมาะสม
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    audioChunks = [];
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data); // เก็บข้อมูลทีละชิ้น

    // เมื่อหยุดบันทึก → รวมชิ้นส่วนเป็น Blob แล้วสร้าง Audio object
    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: mimeType || 'audio/webm' }); // ใช้ mimeType ที่รองรับ
      audioEl = new Audio(URL.createObjectURL(blob)); // แปลง blob → URL สำหรับเล่น
      audioEl.onended = () => { btnPlay.innerHTML = ICON_PLAY; }; // reset icon เมื่อเล่นจบ
      setBtn(btnPlay, true);
      setBtn(btnReset, true);  // เปิดปุ่มรีเซตหลังบันทึกเสร็จ
      statusEl.textContent = 'บันทึกเสร็จแล้ว กดเล่นเสียงได้เลย';
      cancelAnimationFrame(animFrame); // หยุดวาด waveform
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      wrapEl.classList.remove('visible');
    };

    mediaRecorder.start();

    // เริ่มนับเวลา
    seconds = 0;
    timerEl.textContent = fmt(0);
    timerEl.classList.add('recording');
    timerInterval = setInterval(() => { seconds++; timerEl.textContent = fmt(seconds); }, 1000);

    // แสดง waveform และเริ่มวาด
    canvas.width = wrapEl.offsetWidth || 320;
    wrapEl.classList.add('visible');
    drawWave();

    // อัปเดต UI → สถานะกำลังบันทึก
    btnRecord.classList.add('recording');
    pulseRing.classList.add('active');
    statusEl.textContent = 'กำลังบันทึกเสียง...';
    setBtn(btnStop, true);
    setBtn(btnRecord, false);

  } catch (e) {
    // แสดง error ถ้าไมค์ถูก block หรือเกิดปัญหาอื่น
    errorEl.textContent = e.name === 'NotAllowedError'
      ? 'ไม่สามารถเข้าถึงไมค์ได้ กรุณาอนุญาตการใช้งานไมค์ในเบราเซอร์'
      : 'เกิดข้อผิดพลาด: ' + e.message;
    errorEl.style.display = 'block';
  }
});

// --- กดปุ่มหยุด: หยุดบันทึก ---
btnStop.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop()); // ปิด stream ไมค์ด้วย
  }
  clearInterval(timerInterval);
  // reset UI กลับสถานะปกติ
  timerEl.classList.remove('recording');
  btnRecord.classList.remove('recording');
  pulseRing.classList.remove('active');
  setBtn(btnStop, false);
  setBtn(btnRecord, true);
});

// --- กดปุ่มเล่นเสียง: เล่น/หยุดสลับกัน ---
btnPlay.addEventListener('click', () => {
  if (!audioEl) return;
  if (!audioEl.paused) {
    // กำลังเล่นอยู่ → หยุดและ reset กลับต้น
    audioEl.pause();
    audioEl.currentTime = 0;
    btnPlay.innerHTML = ICON_PLAY;
  } else {
    // หยุดอยู่ → เล่น
    audioEl.play();
    btnPlay.innerHTML = ICON_PAUSE;
  }
});

// --- กดปุ่มรีเซต: เคลียร์ทุกอย่างกลับสู่สถานะเริ่มต้น ---
btnReset.addEventListener('click', () => {
  // หยุดบันทึกถ้ากำลังบันทึกอยู่
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
  }

  // หยุดเล่นเสียงถ้ากำลังเล่นอยู่
  if (audioEl) {
    audioEl.pause();
    audioEl.currentTime = 0;
    audioEl = null;
  }

  // เคลียร์ timer และ waveform
  clearInterval(timerInterval);
  cancelAnimationFrame(animFrame);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // reset state ทั้งหมด
  mediaRecorder = null;
  audioChunks   = [];
  seconds       = 0;
  analyser      = null;
  dataArray     = null;
  mimeType      = '';

  // reset UI กลับสถานะเริ่มต้น
  timerEl.textContent = '00:00';
  timerEl.classList.remove('recording');
  statusEl.textContent = 'กดปุ่มไมค์เพื่อเริ่มบันทึก';
  wrapEl.classList.remove('visible');
  btnRecord.classList.remove('recording');
  pulseRing.classList.remove('active');
  btnPlay.innerHTML = ICON_PLAY;
  errorEl.style.display = 'none';

  // reset ปุ่มทั้งหมด
  setBtn(btnRecord, true);
  setBtn(btnStop, false);
  setBtn(btnPlay, false);
  setBtn(btnReset, false);
});