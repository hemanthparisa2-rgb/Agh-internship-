import io
import json
import logging
import os
import tempfile
import threading
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import whisper
from flask import Flask, jsonify, render_template, request, send_file
from gtts import gTTS
import pyttsx3


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024
logging.basicConfig(level=logging.INFO)

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:3b")
WHISPER_MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
ALLOWED_TTS_LANGUAGES = {"en", "de", "es", "fr", "hi"}
ALLOWED_MOODS = {"calm", "happy", "curious", "thoughtful", "empathetic", "excited"}
MOOD_FORMAT = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "mood": {"type": "string", "enum": sorted(ALLOWED_MOODS)},
    },
    "required": ["reply", "mood"],
    "additionalProperties": False,
}

_whisper_model = None
_whisper_model_lock = threading.Lock()
_transcription_lock = threading.Lock()
_speech_lock = threading.Lock()


def get_whisper_model():
    global _whisper_model
    with _whisper_model_lock:
        if _whisper_model is None:
            _whisper_model = whisper.load_model(WHISPER_MODEL_NAME)
    return _whisper_model


def create_boy_voice_audio(text):
    temporary_path = None
    try:
        with _speech_lock:
            engine = pyttsx3.init()
            boy_voice = next(
                (
                    voice
                    for voice in engine.getProperty("voices")
                    if "DAVID" in f"{voice.id} {voice.name}".upper()
                ),
                None,
            )
            if boy_voice is None:
                raise RuntimeError(
                    "The local Microsoft David voice is not installed. "
                    "Select gTTS or enable a male Windows speech voice."
                )
            engine.setProperty("voice", boy_voice.id)
            engine.setProperty("rate", 174)
            engine.setProperty("volume", 0.95)
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as audio_file:
                temporary_path = audio_file.name
            engine.save_to_file(text, temporary_path)
            engine.runAndWait()

        if not os.path.exists(temporary_path) or os.path.getsize(temporary_path) == 0:
            raise RuntimeError("The local voice engine did not create an audio file.")
        with open(temporary_path, "rb") as audio_file:
            return io.BytesIO(audio_file.read())
    finally:
        if temporary_path and os.path.exists(temporary_path):
            os.remove(temporary_path)


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def health():
    return jsonify(
        {
            "status": "ok",
            "model": OLLAMA_MODEL,
            "speech_to_text": f"Whisper {WHISPER_MODEL_NAME}",
            "text_to_speech": "Microsoft David (local) and gTTS",
        }
    )


@app.post("/api/chat")
def chat():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="Send a JSON object with a message."), 400

    message = body.get("message")
    if not isinstance(message, str) or not message.strip():
        return jsonify(error="Please enter a message."), 400
    if len(message) > 4000:
        return jsonify(error="Messages must be 4,000 characters or fewer."), 400

    history = body.get("history", [])
    if not isinstance(history, list):
        return jsonify(error="Conversation history must be a list."), 400

    ollama_messages = [
        {
            "role": "system",
            "content": (
                "You are AURA, a warm, thoughtful voice assistant. "
                "Be helpful, clear, and concise. Keep spoken answers natural. "
                "Return a subtle mood that fits your reply: calm for ordinary "
                "answers, happy for friendly moments, curious for exploration, "
                "thoughtful for analysis, empathetic for distress, and excited "
                "for genuinely good news. Do not overstate the user's emotions."
            ),
        }
    ]
    for item in history[-12:]:
        if (
            isinstance(item, dict)
            and item.get("role") in {"user", "assistant"}
            and isinstance(item.get("content"), str)
        ):
            content = item["content"].strip()
            if content and len(content) <= 4000:
                ollama_messages.append(
                    {"role": item["role"], "content": content}
                )
    ollama_messages.append({"role": "user", "content": message.strip()})

    payload = json.dumps(
        {
            "model": OLLAMA_MODEL,
            "messages": ollama_messages,
            "format": MOOD_FORMAT,
            "stream": False,
        }
    ).encode("utf-8")
    model_request = Request(
        f"{OLLAMA_URL.rstrip('/')}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(model_request, timeout=180) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        logging.exception("Ollama request failed")
        return jsonify(error=f"The local AI returned HTTP {exc.code}."), 502
    except URLError:
        logging.exception("Could not connect to Ollama")
        return (
            jsonify(
                error=(
                    "Can't reach Ollama. Start Ollama and make sure "
                    f"'{OLLAMA_MODEL}' is available."
                )
            ),
            503,
        )
    except (TimeoutError, json.JSONDecodeError):
        logging.exception("Ollama returned an invalid response or timed out")
        return jsonify(error="The local AI timed out or returned an invalid response."), 502

    response_message = result.get("message") if isinstance(result, dict) else None
    content = response_message.get("content") if isinstance(response_message, dict) else None
    if not isinstance(content, str):
        logging.error("Ollama response did not contain message content")
        return jsonify(error="The local AI returned an invalid reply."), 502
    try:
        structured_reply = json.loads(content)
    except json.JSONDecodeError:
        logging.exception("Ollama returned an invalid mood response")
        return jsonify(error="The local AI returned an invalid mood response."), 502

    reply = structured_reply.get("reply") if isinstance(structured_reply, dict) else None
    mood = structured_reply.get("mood") if isinstance(structured_reply, dict) else None
    if not isinstance(reply, str) or not reply.strip() or mood not in ALLOWED_MOODS:
        logging.error("Ollama response did not contain a valid reply and mood")
        return jsonify(error="The local AI returned an incomplete reply."), 502
    return jsonify(reply=reply.strip(), mood=mood)


@app.post("/api/transcribe")
def transcribe():
    audio = request.files.get("audio")
    if audio is None or not audio.filename:
        return jsonify(error="Record a voice message before sending it."), 400

    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as temporary_file:
            temporary_path = temporary_file.name
            audio.save(temporary_file)
        if os.path.getsize(temporary_path) == 0:
            return jsonify(error="The recording was empty. Please try again."), 400

        model = get_whisper_model()
        with _transcription_lock:
            result = model.transcribe(temporary_path, fp16=False)
        transcript = result.get("text", "").strip()
        if not transcript:
            return jsonify(error="I couldn't hear any speech. Please try again."), 422
        return jsonify(text=transcript)
    except Exception:
        logging.exception("Speech transcription failed")
        return jsonify(error="Speech recognition failed. Check that FFmpeg is installed and retry."), 500
    finally:
        if temporary_path and os.path.exists(temporary_path):
            os.remove(temporary_path)


@app.post("/api/speak")
def speak():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="Send a JSON object with text to speak."), 400

    text = body.get("text")
    language = body.get("language", "en")
    voice = body.get("voice", "boy")
    if not isinstance(text, str) or not text.strip():
        return jsonify(error="There is no text to speak."), 400
    if len(text) > 4000:
        return jsonify(error="Speech text must be 4,000 characters or fewer."), 400
    if language not in ALLOWED_TTS_LANGUAGES:
        return jsonify(error="Choose a supported voice language."), 400
    if voice not in {"boy", "gtts"}:
        return jsonify(error="Choose a supported assistant voice."), 400
    if voice == "boy" and language != "en":
        return jsonify(error="The local boy voice is English. Select gTTS for other languages."), 400

    if voice == "boy":
        try:
            audio_stream = create_boy_voice_audio(text.strip())
        except RuntimeError as exc:
            logging.exception("The local boy voice is unavailable")
            return jsonify(error=str(exc)), 503
        except Exception:
            logging.exception("The local boy voice could not generate speech")
            return jsonify(error="The local boy voice failed. Try gTTS instead."), 502
        audio_stream.seek(0)
        return send_file(audio_stream, mimetype="audio/wav", download_name="aura-boy.wav")

    try:
        audio_stream = io.BytesIO()
        gTTS(text=text.strip(), lang=language).write_to_fp(audio_stream)
        audio_stream.seek(0)
    except Exception:
        logging.exception("gTTS could not generate speech")
        return jsonify(error="Text-to-speech is unavailable. Check your internet connection."), 502

    return send_file(audio_stream, mimetype="audio/mpeg", download_name="aura-reply.mp3")


@app.errorhandler(413)
def request_too_large(error):
    logging.warning("Rejected oversized request: %s", error)
    return jsonify(error="Audio recordings must be smaller than 25 MB."), 413


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
