/* =====================================================
   逆再生ボイススタジオ / Reverse Voice Party
   -----------------------------------------------------
   ・録音       : MediaRecorder API
   ・逆再生     : AudioBuffer のチャンネルデータを reverse
   ・ボイス変換 : Web Audio API のノードを組み合わせた簡易エフェクト
   ・保存       : OfflineAudioContext でレンダリング → WAV 化
   音声データはすべてブラウザ内だけで処理されます。
   ===================================================== */
"use strict";

/* =====================================================
   定数
   ===================================================== */
const MAX_RECORD_SEC = 15; // 録音の上限秒数

// 録音前に読み上げるサンプルテキスト
const SAMPLE_TEXTS = [
  "私は今日、伝説のプリンを食べました",
  "リスナーさん、今から魔法をかけます",
  "お寿司が空を飛んでいます",
  "バナナの神様、降臨してください",
  "今日の配信、ここからが本番です",
  "逆再生したら真実がわかるかもしれません",
  "私は何も隠していません、たぶん",
  "この声を聞いた者は、明日ちょっと元気になります",
  "お布団から出たくない同盟、集合",
  "冷蔵庫のプリンを食べた犯人は私です",
];

// ボイスモード定義
// rate: 再生速度（ピッチも変わる） / tail: エコーの余韻ぶん保存時に足す秒数
const VOICE_MODES = {
  normal:   { name: "ノーマル逆再生",         desc: "まずはそのまま逆から",       rate: 1.0,  tail: 0.1 },
  chipmunk: { name: "高い声・チップマンク風", desc: "早口でかわいい高音に",       rate: 1.6,  tail: 0.1 },
  maou:     { name: "低い声・魔王風",         desc: "重低音で威圧感マックス",     rate: 0.6,  tail: 0.2 },
  robot:    { name: "ロボット風",             desc: "ビリビリした機械の声",       rate: 1.0,  tail: 0.1 },
  radio:    { name: "ラジオ風",               desc: "古いラジオから聞こえる声",   rate: 1.0,  tail: 0.1 },
  echo:     { name: "エコー風",               desc: "やまびこみたいに響く",       rate: 1.0,  tail: 2.0 },
  horror:   { name: "ホラー風",               desc: "ゾワッとする不気味さ",       rate: 0.78, tail: 2.5 },
};

/* =====================================================
   状態
   ===================================================== */
let audioContext = null;     // AudioContext（ユーザー操作時に生成）
let mediaStream = null;      // マイクのストリーム
let mediaRecorder = null;    // MediaRecorder
let recordedChunks = [];     // 録音中のデータ片

let recordedBuffer = null;   // 録音した AudioBuffer（普通の向き）
let reversedBuffer = null;   // 逆向きにした AudioBuffer

let currentSource = null;    // 再生中の AudioBufferSourceNode
let currentChain = null;     // 再生中のエフェクトチェーン
let currentAction = null;    // "play" | "reverse" | "voice"

let micAnalyser = null;      // マイク入力用アナライザー（音量メーター）
let playAnalyser = null;     // 再生用アナライザー（ビジュアライザー）

let state = "idle";          // idle | countdown | recording | playing
let selectedMode = "normal"; // 選択中のボイスモード
let recordStartTime = 0;
let recordTimerId = null;

/* =====================================================
   DOM 取得
   ===================================================== */
const $ = (id) => document.getElementById(id);

const recBtn = $("recBtn");
const recRing = $("recRing");
const stopBtn = $("stopBtn");
const playBtn = $("playBtn");
const reverseBtn = $("reverseBtn");
const voiceReverseBtn = $("voiceReverseBtn");
const retakeBtn = $("retakeBtn");
const saveBtn = $("saveBtn");
const saveSelect = $("saveSelect");
const timerDisplay = $("timerDisplay");
const countdownToggle = $("countdownToggle");
const countdownOverlay = $("countdownOverlay");
const statusChip = $("statusChip");
const meterFill = $("meterFill");
const meterHint = $("meterHint");
const visualizer = $("visualizer");
const vCtx = visualizer.getContext("2d");
const modeGrid = $("modeGrid");
const randomModeBtn = $("randomModeBtn");
const speedSlider = $("speedSlider");
const speedValue = $("speedValue");
const bigSample = $("bigSample");
const randomSampleBtn = $("randomSampleBtn");
const sampleGrid = $("sampleGrid");
const errorBar = $("errorBar");
const errorText = $("errorText");
const errorClose = $("errorClose");
const miniModeBtn = $("miniModeBtn");

/* =====================================================
   対応チェック
   ===================================================== */
const isSupported =
  !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
  typeof MediaRecorder !== "undefined" &&
  !!(window.AudioContext || window.webkitAudioContext);

/* =====================================================
   エラー表示（やさしい日本語で）
   ===================================================== */
let errorTimerId = null;

function showError(message, sticky = false) {
  errorText.textContent = message;
  errorBar.hidden = false;
  clearTimeout(errorTimerId);
  if (!sticky) {
    errorTimerId = setTimeout(() => { errorBar.hidden = true; }, 8000);
  }
}

errorClose.addEventListener("click", () => { errorBar.hidden = true; });

/* =====================================================
   AudioContext（スマホの自動再生制限対策：
   ボタンを押した時に作成＆resumeする）
   ===================================================== */
async function ensureAudioContext() {
  if (!audioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioContext = new Ctx();
    // 再生用アナライザーは1回だけ作って出力につないでおく
    playAnalyser = audioContext.createAnalyser();
    playAnalyser.fftSize = 256;
    playAnalyser.connect(audioContext.destination);
  }
  if (audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch (e) {
      showError("音声の準備ができませんでした。もう一度ボタンを押してみてください。");
    }
  }
  return audioContext;
}

/* =====================================================
   マイクの用意
   ===================================================== */
async function getMicStream() {
  if (mediaStream && mediaStream.active) return mediaStream;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
      showError("マイクが使えませんでした。アドレスバーの近くにあるマイクのマークから「許可」を選んで、もう一度試してください。", true);
    } else if (err && err.name === "NotFoundError") {
      showError("マイクが見つかりませんでした。マイクがつながっているか確認してください。", true);
    } else {
      showError("マイクの準備に失敗しました。ページを読み込み直してから、もう一度試してください。");
    }
    throw err;
  }

  // 音量メーター用のアナライザーをマイクにつなぐ
  const ctx = await ensureAudioContext();
  const micSource = ctx.createMediaStreamSource(mediaStream);
  micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 256;
  micSource.connect(micAnalyser); // 出力にはつながない（ハウリング防止）
  meterHint.textContent = "マイクON（音は外部に送信されません）";

  return mediaStream;
}

/* =====================================================
   録音
   ===================================================== */
function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) return type;
  }
  return ""; // ブラウザおまかせ
}

async function startRecording() {
  if (state !== "idle") return; // 連打防止

  try {
    await ensureAudioContext();
    const stream = await getMicStream();

    // カウントダウン（チェックが入っている時だけ）
    if (countdownToggle.checked) {
      setState("countdown");
      await runCountdown(3);
      // カウントダウン中に何かおかしくなっていたら中断
      if (state !== "countdown") return;
    }

    recordedChunks = [];
    const mimeType = pickMimeType();
    mediaRecorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = handleRecordingStopped;

    mediaRecorder.onerror = () => {
      showError("録音中にエラーが起きました。もう一度録音してみてください。");
      setState("idle");
    };

    mediaRecorder.start();
    recordStartTime = performance.now();
    setState("recording");

    // タイマー表示 ＆ 上限で自動ストップ
    recordTimerId = setInterval(() => {
      const sec = (performance.now() - recordStartTime) / 1000;
      updateTimerDisplay(sec);
      if (sec >= MAX_RECORD_SEC) stopRecording();
    }, 100);
  } catch (e) {
    setState("idle");
  }
}

function stopRecording() {
  if (state !== "recording" || !mediaRecorder) return;
  clearInterval(recordTimerId);
  try {
    mediaRecorder.stop();
  } catch (e) {
    showError("録音の停止に失敗しました。ページを読み込み直してみてください。");
    setState("idle");
  }
}

// 録音が止まったら AudioBuffer に変換して、逆向きバージョンも作る
async function handleRecordingStopped() {
  try {
    const blob = new Blob(recordedChunks, {
      type: mediaRecorder.mimeType || "audio/webm",
    });

    if (blob.size === 0) {
      showError("録音できていませんでした。もう少し長めに録音してみてください。");
      setState("idle");
      return;
    }

    const arrayBuffer = await blob.arrayBuffer();
    const ctx = await ensureAudioContext();
    recordedBuffer = await decodeAudio(ctx, arrayBuffer);
    reversedBuffer = makeReversedBuffer(ctx, recordedBuffer);

    updateTimerDisplay(recordedBuffer.duration);
    setState("idle");
  } catch (e) {
    showError("録音データを読み込めませんでした。もう一度録音してみてください。");
    recordedBuffer = null;
    reversedBuffer = null;
    setState("idle");
  }
}

// decodeAudioData（古いSafariのコールバック形式にも対応）
function decodeAudio(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const maybePromise = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (maybePromise && typeof maybePromise.then === "function") {
      maybePromise.then(resolve).catch(reject);
    }
  });
}

/* =====================================================
   逆再生バッファ生成
   （チャンネルデータをコピーして reverse するだけ！）
   ===================================================== */
function makeReversedBuffer(ctx, buffer) {
  const reversed = ctx.createBuffer(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate
  );
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = new Float32Array(buffer.getChannelData(ch)); // コピー
    data.reverse();                                           // 逆順に
    reversed.copyToChannel(data, ch);
  }
  return reversed;
}

/* =====================================================
   エフェクトチェーン
   AudioContext / OfflineAudioContext のどちらでも使える
   ===================================================== */

// 歪み用のカーブ（tanhでソフトクリップ）
function makeDistortionCurve(amount) {
  const samples = 256;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.tanh(amount * x);
  }
  return curve;
}

/**
 * ボイスモードに応じたノードのつながりを作る
 * @returns {{input: AudioNode, output: AudioNode, oscillators: OscillatorNode[]}}
 */
function buildEffectChain(ctx, modeKey) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const oscillators = []; // 停止時に止めるため覚えておく

  switch (modeKey) {
    case "chipmunk": {
      // 高さは playbackRate 側で処理。声のシャリ感を少し足す
      const high = ctx.createBiquadFilter();
      high.type = "highshelf";
      high.frequency.value = 3000;
      high.gain.value = 3;
      input.connect(high).connect(output);
      break;
    }

    case "maou": {
      // 低さは playbackRate 側。低音を持ち上げて軽く歪ませる
      const low = ctx.createBiquadFilter();
      low.type = "lowshelf";
      low.frequency.value = 220;
      low.gain.value = 8;
      const shaper = ctx.createWaveShaper();
      shaper.curve = makeDistortionCurve(1.6);
      input.connect(low).connect(shaper).connect(output);
      break;
    }

    case "robot": {
      // リングモジュレーション（信号 × サイン波）で機械声に
      const ring = ctx.createGain();
      ring.gain.value = 0; // ベース0にしてオシレーターで揺らす
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 55;
      osc.connect(ring.gain);
      osc.start();
      oscillators.push(osc);

      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 1200;
      band.Q.value = 0.7;

      const makeup = ctx.createGain();
      makeup.gain.value = 1.8; // リングモジュレーションで下がる音量を補う

      input.connect(ring).connect(band).connect(makeup).connect(output);
      break;
    }

    case "radio": {
      // 帯域を狭くして軽く歪ませると古いラジオっぽい
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 500;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 2600;
      const shaper = ctx.createWaveShaper();
      shaper.curve = makeDistortionCurve(4);
      const gain = ctx.createGain();
      gain.gain.value = 1.2;
      input.connect(hp).connect(lp).connect(shaper).connect(gain).connect(output);
      break;
    }

    case "echo": {
      // ディレイ＋フィードバックのシンプルなやまびこ
      const delay = ctx.createDelay(1.0);
      delay.delayTime.value = 0.28;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.45;
      const wet = ctx.createGain();
      wet.gain.value = 0.6;

      input.connect(output);                    // 元の音（ドライ）
      input.connect(delay);
      delay.connect(feedback).connect(delay);   // フィードバックループ
      delay.connect(wet).connect(output);       // 響き（ウェット）
      break;
    }

    case "horror": {
      // 低め再生（rate側）＋トレモロの揺れ＋長めのエコー＋こもり
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 2200;

      // トレモロ：ゲインをLFOで揺らす
      const trem = ctx.createGain();
      trem.gain.value = 0.75;
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 4.5;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.25;
      lfo.connect(lfoDepth).connect(trem.gain);
      lfo.start();
      oscillators.push(lfo);

      const delay = ctx.createDelay(1.0);
      delay.delayTime.value = 0.4;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.5;
      const wet = ctx.createGain();
      wet.gain.value = 0.5;

      input.connect(lp).connect(trem);
      trem.connect(output);                     // ドライ
      trem.connect(delay);
      delay.connect(feedback).connect(delay);   // フィードバック
      delay.connect(wet).connect(output);       // ウェット
      break;
    }

    case "normal":
    default: {
      input.connect(output);
      break;
    }
  }

  return { input, output, oscillators };
}

/* =====================================================
   再生 / 停止
   ===================================================== */
function userSpeed() {
  return parseFloat(speedSlider.value) || 1.0;
}

/**
 * @param {AudioBuffer} buffer   再生するバッファ
 * @param {string} modeKey       ボイスモード
 * @param {"play"|"reverse"|"voice"} action どのボタンから来たか
 */
async function playBuffer(buffer, modeKey, action) {
  if (!buffer) {
    showError("まだ録音がありません。先に「録音スタート」で声を録ってください。");
    return;
  }

  // 同じボタンをもう一度押したら停止（トグル動作）
  if (state === "playing" && currentAction === action) {
    stopPlayback();
    return;
  }

  stopPlayback(); // 別の再生中なら止めてから

  try {
    const ctx = await ensureAudioContext();

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const mode = VOICE_MODES[modeKey] || VOICE_MODES.normal;
    source.playbackRate.value = mode.rate * userSpeed();

    const chain = buildEffectChain(ctx, modeKey);
    source.connect(chain.input);
    chain.output.connect(playAnalyser); // ビジュアライザー経由で出力へ

    source.onended = () => {
      // 途中停止でも最後まで再生でもここに来る
      if (currentSource === source) {
        cleanupPlayback();
        setState("idle");
      }
    };

    currentSource = source;
    currentChain = chain;
    currentAction = action;

    source.start();
    setState("playing");
  } catch (e) {
    cleanupPlayback();
    setState("idle");
    showError("再生に失敗しました。もう一度ボタンを押してみてください。");
  }
}

function stopPlayback() {
  if (currentSource) {
    try { currentSource.stop(); } catch (e) { /* すでに停止済みならOK */ }
  }
}

function cleanupPlayback() {
  if (currentChain) {
    try { currentChain.output.disconnect(); } catch (e) {}
    currentChain.oscillators.forEach((osc) => {
      try { osc.stop(); } catch (e) {}
    });
  }
  currentSource = null;
  currentChain = null;
  currentAction = null;
}

/* =====================================================
   録り直し
   ===================================================== */
function retake() {
  if (state === "playing") stopPlayback();
  recordedBuffer = null;
  reversedBuffer = null;
  updateTimerDisplay(0);
  setState("idle");
}

/* =====================================================
   保存（WAV）
   OfflineAudioContext でエフェクトごとレンダリングする
   ===================================================== */
async function renderToBuffer(buffer, modeKey, speed) {
  const mode = VOICE_MODES[modeKey] || VOICE_MODES.normal;
  const rate = mode.rate * speed;
  const durationSec = buffer.duration / rate + mode.tail;
  const length = Math.max(1, Math.ceil(durationSec * buffer.sampleRate));

  const offline = new OfflineAudioContext(
    buffer.numberOfChannels,
    length,
    buffer.sampleRate
  );

  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;

  const chain = buildEffectChain(offline, modeKey);
  source.connect(chain.input);
  chain.output.connect(offline.destination);

  source.start();
  return offline.startRendering();
}

// AudioBuffer → 16bit PCM の WAV Blob
function bufferToWavBlob(buffer) {
  const numCh = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const dataSize = buffer.length * numCh * 2;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  // WAVヘッダー
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);          // fmtチャンクサイズ
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);          // 16bit
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  // サンプル書き込み（インターリーブ）
  const channels = [];
  for (let ch = 0; ch < numCh; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      let s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

async function saveAudio() {
  if (!recordedBuffer) {
    showError("まだ録音がありません。先に声を録ってから保存してください。");
    return;
  }

  try {
    saveBtn.disabled = true;
    const kind = saveSelect.value;
    let outBuffer;
    let label;

    if (kind === "normal") {
      outBuffer = recordedBuffer;
      label = "normal";
    } else if (kind === "reverse") {
      outBuffer = reversedBuffer;
      label = "reverse";
    } else {
      // 変な声で逆再生：今のモード＆スピードを焼き込んで書き出す
      outBuffer = await renderToBuffer(reversedBuffer, selectedMode, userSpeed());
      label = `reverse-${selectedMode}`;
    }

    const blob = bufferToWavBlob(outBuffer);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `reverse-voice_${label}_${stamp}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    showError("保存に失敗しました。もう一度試してみてください。");
  } finally {
    updateUI();
  }
}

/* =====================================================
   カウントダウン（音は鳴らさず表示だけ）
   ===================================================== */
function runCountdown(from) {
  return new Promise((resolve) => {
    let n = from;
    countdownOverlay.hidden = false;
    countdownOverlay.textContent = n;
    const id = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(id);
        countdownOverlay.hidden = true;
        resolve();
      } else {
        countdownOverlay.textContent = n;
      }
    }, 800);
  });
}

/* =====================================================
   状態管理と UI 更新
   ===================================================== */
const STATUS_LABELS = {
  idle: "待機中",
  countdown: "カウントダウン",
  recording: "録音中 ●REC",
  playing: "再生中",
  reversing: "逆再生中",
};

function setState(next) {
  state = next;
  updateUI();
}

function updateUI() {
  const hasRecording = !!recordedBuffer;
  const busy = state !== "idle";

  // 状態チップ
  let statusKey = state;
  if (state === "playing") {
    statusKey = currentAction === "play" ? "playing" : "reversing";
  }
  statusChip.textContent = STATUS_LABELS[statusKey] || STATUS_LABELS.idle;
  statusChip.className = "status-chip is-" + statusKey;

  // 録音まわり
  recBtn.disabled = !isSupported || busy;
  stopBtn.disabled = state !== "recording";
  recRing.classList.toggle("is-recording", state === "recording");
  timerDisplay.classList.toggle("is-recording", state === "recording");

  // 再生系：録音がない時は無効。再生中は「今鳴っているボタン」だけ押せる（＝停止できる）
  const canPlay = hasRecording && isSupported;
  playBtn.disabled = !canPlay || (busy && !(state === "playing" && currentAction === "play"));
  reverseBtn.disabled = !canPlay || (busy && !(state === "playing" && currentAction === "reverse"));
  voiceReverseBtn.disabled = !canPlay || (busy && !(state === "playing" && currentAction === "voice"));

  playBtn.classList.toggle("is-active", state === "playing" && currentAction === "play");
  reverseBtn.classList.toggle("is-active", state === "playing" && currentAction === "reverse");
  voiceReverseBtn.classList.toggle("is-active", state === "playing" && currentAction === "voice");

  retakeBtn.disabled = !hasRecording || state === "recording" || state === "countdown";
  saveBtn.disabled = !canPlay || busy;
}

function updateTimerDisplay(sec) {
  const shown = Math.min(sec, MAX_RECORD_SEC);
  const m = Math.floor(shown / 60);
  const s = Math.floor(shown % 60).toString().padStart(2, "0");
  timerDisplay.innerHTML =
    `${m}:${s} <span class="timer-max">/ 0:${MAX_RECORD_SEC}</span>`;
}

/* =====================================================
   音量メーター ＆ ビジュアライザー（1つのループで描画）
   ===================================================== */
const meterData = new Uint8Array(128);
const vizData = new Uint8Array(128);

function drawLoop() {
  requestAnimationFrame(drawLoop);

  // ---- 音量メーター（マイク入力のRMS）----
  if (micAnalyser) {
    micAnalyser.getByteTimeDomainData(meterData);
    let sum = 0;
    for (let i = 0; i < meterData.length; i++) {
      const v = (meterData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / meterData.length);
    const percent = Math.min(100, rms * 260); // 見やすいように増幅
    meterFill.style.width = percent.toFixed(1) + "%";
  }

  // ---- ビジュアライザー ----
  const w = visualizer.width;
  const h = visualizer.height;
  vCtx.clearRect(0, 0, w, h);

  let analyser = null;
  if (state === "recording" && micAnalyser) analyser = micAnalyser;
  else if (state === "playing" && playAnalyser) analyser = playAnalyser;

  if (analyser) {
    analyser.getByteFrequencyData(vizData);
    const barCount = 48;
    const step = Math.floor(vizData.length / barCount);
    const barWidth = w / barCount;

    for (let i = 0; i < barCount; i++) {
      const value = vizData[i * step] / 255;
      const barHeight = Math.max(3, value * (h - 12));
      const x = i * barWidth;
      const y = h - barHeight - 4;

      // 録音中は赤、再生中はシアン→ピンクのグラデーション
      if (state === "recording") {
        vCtx.fillStyle = `rgba(255, 56, 96, ${0.5 + value * 0.5})`;
      } else {
        const grad = vCtx.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, "#35e6ff");
        grad.addColorStop(0.6, "#ff4fd8");
        grad.addColorStop(1, "#f5ff3d");
        vCtx.fillStyle = grad;
        vCtx.globalAlpha = 0.4 + value * 0.6;
      }
      vCtx.fillRect(x + 2, y, barWidth - 4, barHeight);
      vCtx.globalAlpha = 1;
    }
  } else {
    // 待機中：うすい基準線だけ
    vCtx.fillStyle = "rgba(155, 92, 255, 0.35)";
    vCtx.fillRect(0, h / 2 - 1, w, 2);
  }
}

// canvasの実サイズを表示サイズに合わせる（にじみ防止）
function fitCanvas() {
  const rect = visualizer.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  visualizer.width = Math.max(1, Math.round(rect.width * dpr));
  visualizer.height = Math.max(1, Math.round(rect.height * dpr));
}
window.addEventListener("resize", fitCanvas);

/* =====================================================
   ボイスモード UI 生成
   ===================================================== */
function buildModeGrid() {
  Object.entries(VOICE_MODES).forEach(([key, mode]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mode-btn";
    btn.dataset.mode = key;
    btn.setAttribute("aria-pressed", String(key === selectedMode));
    btn.innerHTML =
      `<span class="mode-name">${mode.name}</span>` +
      `<span class="mode-desc">${mode.desc}</span>`;
    btn.addEventListener("click", () => selectMode(key));
    modeGrid.appendChild(btn);
  });
  refreshModeGrid();
}

function selectMode(key) {
  selectedMode = key;
  refreshModeGrid();
}

function refreshModeGrid() {
  modeGrid.querySelectorAll(".mode-btn").forEach((btn) => {
    const on = btn.dataset.mode === selectedMode;
    btn.classList.toggle("is-selected", on);
    btn.setAttribute("aria-pressed", String(on));
  });
}

// 🎲 おまかせ：今と違うモードをランダムに選ぶ
randomModeBtn.addEventListener("click", () => {
  const keys = Object.keys(VOICE_MODES).filter((k) => k !== selectedMode);
  selectMode(keys[Math.floor(Math.random() * keys.length)]);
});

/* =====================================================
   サンプルテキスト（お題）
   ===================================================== */
let currentSampleIndex = 0;

function buildSampleGrid() {
  SAMPLE_TEXTS.forEach((text, i) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "sample-card";
    card.textContent = "「" + text + "」";
    card.addEventListener("click", () => setSample(i));
    sampleGrid.appendChild(card);
  });
  setSample(0, false);
}

function setSample(index, pop = true) {
  currentSampleIndex = index;
  bigSample.textContent = "「" + SAMPLE_TEXTS[index] + "」";

  sampleGrid.querySelectorAll(".sample-card").forEach((card, i) => {
    card.classList.toggle("is-current", i === index);
  });

  if (pop) {
    bigSample.classList.remove("is-pop");
    // reflowを挟んでアニメーションをリスタート
    void bigSample.offsetWidth;
    bigSample.classList.add("is-pop");
  }
}

randomSampleBtn.addEventListener("click", () => {
  let next = currentSampleIndex;
  while (next === currentSampleIndex && SAMPLE_TEXTS.length > 1) {
    next = Math.floor(Math.random() * SAMPLE_TEXTS.length);
  }
  setSample(next);
});

/* =====================================================
   ミニモード
   ===================================================== */
miniModeBtn.addEventListener("click", () => {
  const mini = document.body.classList.toggle("mini");
  miniModeBtn.setAttribute("aria-pressed", String(mini));
  miniModeBtn.textContent = mini ? "通常モード" : "ミニモード";
  fitCanvas();
});

/* =====================================================
   イベント登録
   ===================================================== */
recBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);
playBtn.addEventListener("click", () => playBuffer(recordedBuffer, "normal", "play"));
reverseBtn.addEventListener("click", () => playBuffer(reversedBuffer, "normal", "reverse"));
voiceReverseBtn.addEventListener("click", () => playBuffer(reversedBuffer, selectedMode, "voice"));
retakeBtn.addEventListener("click", retake);
saveBtn.addEventListener("click", saveAudio);

speedSlider.addEventListener("input", () => {
  speedValue.textContent = "x" + userSpeed().toFixed(2);
});

/* =====================================================
   初期化
   ===================================================== */
function init() {
  buildModeGrid();
  buildSampleGrid();
  fitCanvas();
  drawLoop();
  updateUI();

  if (!isSupported) {
    showError("お使いのブラウザは録音機能に対応していないようです。最新のChrome・Edge・Safariなどで開いてみてください。", true);
  }
}

init();
