# AURA — AI voice assistant

A local 16:9 talking-avatar assistant with a Flask web UI, Whisper speech
recognition, Ollama chat, a local Microsoft David boy voice, optional gTTS,
emotion-aware stage lighting, and an audio-reactive mouth overlay.
The supplied still image is not converted into a full-motion video; the mouth
overlay opens and closes in time with speech playback.

## Run on Windows

The current environment already has Flask, Whisper, gTTS, FFmpeg, and the
`llama3.2:3b` Ollama model installed.

```powershell
python app.py
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000). The chat sits below the
16:9 avatar stage, and new replies are spoken automatically. The local boy voice
is the default; choose gTTS in the voice selector for Google speech and additional
languages. Keep Ollama running locally.
The first voice message loads Whisper's cached `base` model; FFmpeg is used to
decode the browser recording. The boy voice is generated on your computer.
gTTS sends reply text to Google's text-to-speech service and requires an internet connection.

## Configuration

```powershell
$env:OLLAMA_MODEL = "llama3.2:3b"
$env:OLLAMA_URL = "http://127.0.0.1:11434"
$env:WHISPER_MODEL = "base"
python app.py
```

The Ollama model and Whisper model can be changed through these environment
variables. Whisper downloads a model if it isn't already present in its cache.
