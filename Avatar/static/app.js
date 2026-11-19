const chatForm = document.querySelector("#chat-form");
const messageInput = document.querySelector("#message-input");
const chatLog = document.querySelector("#chat-log");
const sendButton = document.querySelector("#send-button");
const micButton = document.querySelector("#mic-button");
const micLabel = document.querySelector("#mic-label");
const statusToast = document.querySelector("#status-toast");
const suggestions = document.querySelector("#suggestions");
const connectionLabel = document.querySelector("#connection-label");
const voiceLanguage = document.querySelector("#voice-language");
const voiceProfile = document.querySelector("#voice-profile");
const avatarStage = document.querySelector("#avatar-stage");
const avatarStatus = document.querySelector("#avatar-status-label");
const avatarMoodLabel = document.querySelector("#avatar-mood-label");

const availableMoods = ["calm", "happy", "curious", "thoughtful", "empathetic", "excited"];
let conversation = [];
let mediaRecorder = null;
let toastTimer = null;
let busy = false;
let speechRequestId = 0;
let speechAudioContext = null;
let speechAnalyser = null;
let activeAudio = null;
let activeAudioSource = null;
let activeAudioUrl = null;
let lipSyncFrame = 0;

function showStatus(message) {
  statusToast.textContent = message;
  statusToast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => statusToast.classList.remove("visible"), 4200);
}

function currentTime() {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date());
}

function addMessage(role, text, mood = "calm") {
  const article = document.createElement("article");
  article.className = `message ${role === "user" ? "user-message" : "assistant-message"}`;
  if (role === "assistant") article.dataset.mood = mood;
  const content = document.createElement("div");
  content.className = "message-content";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const name = document.createElement("strong");
  name.textContent = role === "user" ? "YOU" : "AURA";
  const time = document.createElement("time");
  time.textContent = currentTime();
  meta.append(name, time);

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = text;
  content.append(meta, bubble);

  if (role === "assistant") {
    const listenButton = document.createElement("button");
    listenButton.type = "button";
    listenButton.className = "listen-button";
    listenButton.dataset.speechText = text;
    listenButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7m3-10a9 9 0 0 1 0 13"/></svg>Listen';
    content.append(listenButton);
    article.insertAdjacentHTML("afterbegin", '<span class="message-avatar">A</span>');
  }
  article.append(content);
  chatLog.append(article);
  chatLog.scrollTop = chatLog.scrollHeight;
  return article;
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  messageInput.disabled = value;
  micButton.disabled = value;
  chatForm.setAttribute("aria-busy", String(value));
}

function addTypingIndicator() {
  const indicator = document.createElement("article");
  indicator.className = "message assistant-message";
  indicator.id = "typing-indicator";
  indicator.innerHTML = '<span class="message-avatar">A</span><div class="message-content"><div class="message-meta"><strong>AURA</strong></div><div class="message-bubble typing-dots" aria-label="AURA is thinking"><i></i><i></i><i></i></div></div>';
  chatLog.append(indicator);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function sendMessage(text) {
  const trimmed = text.trim();
  if (!trimmed || busy) return;
  stopAvatarSpeech();
  setAvatarMood("thoughtful");
  setAvatarStatus("THINKING");
  setBusy(true);
  suggestions.hidden = true;
  addMessage("user", trimmed);
  messageInput.value = "";
  messageInput.style.height = "auto";
  addTypingIndicator();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: trimmed, history: conversation })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "AURA couldn't reply. Please try again.");
    conversation.push({ role: "user", content: trimmed }, { role: "assistant", content: data.reply });
    conversation = conversation.slice(-12);
    addMessage("assistant", data.reply, data.mood);
    setAvatarMood(data.mood);
    void speakText(data.reply);
  } catch (error) {
    showStatus(error.message);
    setAvatarMood("calm");
    setAvatarStatus("AURA IS LISTENING");
  } finally {
    document.querySelector("#typing-indicator")?.remove();
    setBusy(false);
    messageInput.focus();
  }
}

function setAvatarStatus(message) {
  avatarStatus.textContent = message;
}

function setAvatarMood(mood) {
  const selectedMood = availableMoods.includes(mood) ? mood : "calm";
  avatarStage.dataset.mood = selectedMood;
  avatarMoodLabel.textContent = selectedMood.toUpperCase();
}

function finishAvatarPlayback(audio) {
  if (activeAudio !== audio) return;
  cancelAnimationFrame(lipSyncFrame);
  if (activeAudioSource) {
    activeAudioSource.disconnect();
    activeAudioSource = null;
  }
  activeAudio.pause();
  activeAudio = null;
  avatarStage.classList.remove("is-speaking");
  avatarStage.style.setProperty("--mouth-open", "0");
  setAvatarStatus("AURA IS LISTENING");
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
}

function stopAvatarSpeech() {
  speechRequestId += 1;
  if (activeAudio) finishAvatarPlayback(activeAudio);
  else {
    avatarStage.classList.remove("is-speaking");
    avatarStage.style.setProperty("--mouth-open", "0");
    setAvatarStatus("AURA IS LISTENING");
  }
}

function animateAvatarMouth(audio) {
  const samples = new Uint8Array(speechAnalyser.fftSize);
  let smoothedLevel = 0;
  const updateMouth = () => {
    if (activeAudio !== audio || audio.paused || audio.ended) return;
    speechAnalyser.getByteTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) {
      const amplitude = (sample - 128) / 128;
      energy += amplitude * amplitude;
    }
    const rms = Math.sqrt(energy / samples.length);
    const target = Math.min(1, Math.max(0, (rms - 0.012) * 9));
    smoothedLevel += (target - smoothedLevel) * (target > smoothedLevel ? 0.48 : 0.28);
    avatarStage.style.setProperty("--mouth-open", smoothedLevel.toFixed(3));
    lipSyncFrame = requestAnimationFrame(updateMouth);
  };
  updateMouth();
}

async function speakText(text, button = null) {
  const requestId = ++speechRequestId;
  if (activeAudio) finishAvatarPlayback(activeAudio);
  const originalLabel = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.textContent = "Preparing voice…";
  }
  setAvatarStatus("PREPARING VOICE");
  try {
    const response = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language: voiceLanguage.value, voice: voiceProfile.value })
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Couldn't prepare the audio.");
    }
    const audioUrl = URL.createObjectURL(await response.blob());
    if (requestId !== speechRequestId) {
      URL.revokeObjectURL(audioUrl);
      return;
    }
    const audio = new Audio(audioUrl);
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      speechAudioContext ??= new AudioContextClass();
      speechAnalyser ??= speechAudioContext.createAnalyser();
      speechAnalyser.fftSize = 256;
      speechAnalyser.smoothingTimeConstant = 0.35;
      speechAnalyser.connect(speechAudioContext.destination);
      activeAudioSource = speechAudioContext.createMediaElementSource(audio);
      activeAudioSource.connect(speechAnalyser);
    }
    activeAudio = audio;
    activeAudioUrl = audioUrl;
    audio.addEventListener("ended", () => finishAvatarPlayback(audio), { once: true });
    audio.addEventListener("error", () => finishAvatarPlayback(audio), { once: true });
    if (speechAudioContext) await speechAudioContext.resume();
    if (requestId !== speechRequestId) {
      finishAvatarPlayback(audio);
      return;
    }
    await audio.play();
    if (requestId !== speechRequestId) {
      finishAvatarPlayback(audio);
      return;
    }
    avatarStage.classList.add("is-speaking");
    setAvatarStatus("AURA IS SPEAKING");
    if (speechAnalyser) animateAvatarMouth(audio);
  } catch (error) {
    if (requestId === speechRequestId) {
      if (activeAudio) finishAvatarPlayback(activeAudio);
      setAvatarStatus("AURA IS LISTENING");
      showStatus(error.name === "NotAllowedError" ? "Tap Listen to let AURA speak and sync the avatar." : error.message);
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = originalLabel;
    }
  }
}

async function playSpeech(button) {
  await speakText(button.dataset.speechText, button);
}

async function transcribeRecording(blob) {
  if (!blob.size) {
    showStatus("The recording was empty. Please try again.");
    return;
  }
  setBusy(true);
  micLabel.textContent = "Transcribing…";
  showStatus("Transcribing your voice with Whisper…");
  const formData = new FormData();
  formData.append("audio", blob, "voice.webm");
  try {
    const response = await fetch("/api/transcribe", { method: "POST", body: formData });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Couldn't transcribe that recording.");
    micLabel.textContent = "Voice";
    setBusy(false);
    await sendMessage(data.text);
  } catch (error) {
    micLabel.textContent = "Voice";
    setBusy(false);
    showStatus(error.message);
  }
}

micButton.addEventListener("click", async () => {
  if (busy) return;
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    micButton.classList.remove("is-recording");
    micButton.setAttribute("aria-label", "Start voice recording");
    micLabel.textContent = "Voice";
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showStatus("Voice recording isn't supported in this browser. Try the text box instead.");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      transcribeRecording(new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" }));
    }, { once: true });
    mediaRecorder.start();
    micButton.classList.add("is-recording");
    micButton.setAttribute("aria-label", "Stop voice recording");
    micLabel.textContent = "Stop";
  } catch (error) {
    showStatus(error.name === "NotAllowedError" ? "Allow microphone access in your browser to use voice input." : "Couldn't start your microphone. Check the device and try again.");
  }
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(messageInput.value);
});

messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 100)}px`;
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

document.querySelector("#new-chat").addEventListener("click", resetConversation);
document.querySelector("#clear-chat").addEventListener("click", resetConversation);

function resetConversation() {
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
  stopAvatarSpeech();
  setAvatarMood("calm");
  conversation = [];
  chatLog.replaceChildren();
  suggestions.hidden = false;
  messageInput.value = "";
  addMessage("assistant", "A fresh start. What would you like to talk about?");
}

document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => sendMessage(button.dataset.prompt));
});

function syncVoiceSettings() {
  const usesBoyVoice = voiceProfile.value === "boy";
  voiceLanguage.disabled = usesBoyVoice;
  if (usesBoyVoice) voiceLanguage.value = "en";
}

voiceProfile.addEventListener("change", syncVoiceSettings);
syncVoiceSettings();

chatLog.addEventListener("click", (event) => {
  const button = event.target.closest(".listen-button");
  if (button) playSpeech(button);
});

async function checkConnection() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error("offline");
    const data = await response.json();
    connectionLabel.textContent = `Local AI · ${data.model}`;
  } catch {
    connectionLabel.textContent = "Checking local AI…";
  }
}

checkConnection();
