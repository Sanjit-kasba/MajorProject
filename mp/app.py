import datetime
import hashlib
import hmac
import math
import os
import re
import secrets
import subprocess
import threading
import time
import uuid
from collections import Counter
from functools import wraps

import librosa
import requests
import whisper
from flask import Flask, g, jsonify, request, send_file
from flask_cors import CORS
from pymongo import MongoClient, ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError
from transformers import pipeline
from werkzeug.security import check_password_hash, generate_password_hash

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
print("Loading Whisper Model...")
whisper_model = whisper.load_model("base", device="cpu")

print("Loading Emotion Model...")
emotion_classifier = pipeline("audio-classification", model="superb/wav2vec2-base-superb-er")
print("Model Ready!")

# The models are not guaranteed to be thread-safe, so inference is serialised.
model_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")
OUTPUT_FOLDER = os.path.join(BASE_DIR, "outputs")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

MAX_QUESTIONS = 5
TOKEN_TTL_HOURS = 12
FILE_MAX_AGE_SECONDS = 3600
OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "llama3"
CLOSING_TEXT = "That concludes the interview. Thank you for your time."
SILENCE_TEXT = "I didn't quite catch that. Could you please repeat your answer?"
LANGUAGE_CODES = {"english": "en"}  # language name -> Whisper language code
DIFFICULTIES = {"easy", "medium", "hard"}
MODES = {"video", "voice"}

# Domain-specific opening questions (keys match the Domain dropdown values).
FIRST_QUESTIONS = {
    "Artificial Intelligence": {
        "easy": "What is machine learning, and how is it different from traditional programming?",
        "medium": "Explain the difference between supervised and unsupervised learning, with a real example of each.",
        "hard": "How would you detect and mitigate overfitting in a deep neural network trained on a small dataset?",
    },
    "Data Structures and Algorithms": {
        "easy": "What is the difference between an array and a linked list?",
        "medium": "How does a hash table work, and how are collisions handled?",
        "hard": "How would you design an LRU cache, and what time complexity can you achieve for each operation?",
    },
    "Cybersecurity": {
        "easy": "What is the difference between authentication and authorization?",
        "medium": "Explain how SQL injection works and how you would prevent it.",
        "hard": "Walk me through how you would investigate and contain a suspected ransomware infection on a corporate network.",
    },
    "Web Development": {
        "easy": "What roles do HTML, CSS, and JavaScript each play in a web page?",
        "medium": "Explain how the browser event loop works and why it matters for JavaScript.",
        "hard": "How would you diagnose and optimise a slow web page end to end, from server to rendering?",
    },
    "Cloud Computing": {
        "easy": "What is cloud computing, and what are IaaS, PaaS, and SaaS?",
        "medium": "Explain horizontal versus vertical scaling, and when you would use each.",
        "hard": "How would you design a highly available, fault-tolerant web application across multiple regions?",
    },
}

# wav2vec2 emotion labels -> display labels used by the frontend
EMOTION_MAP = {
    "neu": "Professional",
    "hap": "Enthusiastic",
    "ang": "Tense",
    "sad": "Subdued",
}
# How well each vocal tone supports a confident delivery (0-100)
EMOTION_SCORES = {
    "Confident": 90,
    "Enthusiastic": 90,
    "Professional": 80,
    "Calm": 75,
    "Subdued": 55,
    "Tense": 50,
}
FILLER_PATTERN = re.compile(
    r"\b(um+|uh+|er+|erm|ah+|hmm+|you know|i mean|basically|sort of|kind of)\b", re.IGNORECASE
)
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,30}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024  # 25 MB upload cap
CORS(app)


@app.errorhandler(413)
def too_large(_e):
    return jsonify({"error": "Audio upload is too large"}), 413


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# MongoDB
# ---------------------------------------------------------------------------
client = MongoClient("mongodb://localhost:27017/", serverSelectionTimeoutMS=3000, connectTimeoutMS=3000, socketTimeoutMS=5000)
db = client["intraview_db"]
users_collection = db["users"]
history_collection = db["history"]
sessions_collection = db["sessions"]
tokens_collection = db["tokens"]


def ensure_indexes():
    """Create indexes safely: never block or crash startup if MongoDB is slow, down, or has duplicates."""
    try:
        client.admin.command("ping")
    except PyMongoError as e:
        print("WARNING: MongoDB not reachable, skipping index creation:", e)
        return

    specs = [
        (users_collection, [("username", 1)], {"unique": True}),
        (users_collection, [("email", 1)], {"unique": True}),
        (tokens_collection, [("token_hash", 1)], {"unique": True}),
        (tokens_collection, [("expires_at", 1)], {"expireAfterSeconds": 0}),
        (sessions_collection, [("username", 1)], {}),
        (history_collection, [("username", 1)], {}),
        (
            history_collection,
            [("session_id", 1)],
            {"unique": True, "partialFilterExpression": {"session_id": {"$type": "string"}}},
        ),
    ]
    for coll, keys, opts in specs:
        try:
            coll.create_index(keys, **opts)
        except PyMongoError as e:
            print(f"WARNING: could not create index {keys} on {coll.name}: {e}")


ensure_indexes()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def clamp(value, lo=0, hi=100):
    return max(lo, min(hi, value))


def half_up(value):
    """Round half up (same as JavaScript Math.round for positive numbers)."""
    return int(math.floor(value + 0.5))


def text_field(data, key, max_len=200):
    value = data.get(key)
    return value.strip()[:max_len] if isinstance(value, str) else ""


def sha256_hex(value):
    return hashlib.sha256(value.encode()).hexdigest()


def is_legacy_hash(stored):
    return isinstance(stored, str) and re.fullmatch(r"[0-9a-f]{64}", stored) is not None


def verify_password(stored, password):
    if not isinstance(stored, str) or not password:
        return False
    if is_legacy_hash(stored):  # accounts created before salted hashing
        return hmac.compare_digest(stored, sha256_hex(password))
    return check_password_hash(stored, password)


def cleanup_old_files():
    cutoff = time.time() - FILE_MAX_AGE_SECONDS
    for folder in (UPLOAD_FOLDER, OUTPUT_FOLDER):
        try:
            for name in os.listdir(folder):
                path = os.path.join(folder, name)
                if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                    os.remove(path)
        except OSError:
            pass


def remove_files(*paths):
    for path in paths:
        try:
            if path and os.path.isfile(path):
                os.remove(path)
        except OSError:
            pass


cleanup_old_files()


# ---------------------------------------------------------------------------
# Auth (bearer tokens, stored hashed with an expiry)
# ---------------------------------------------------------------------------
def create_token(username):
    token = secrets.token_urlsafe(32)
    tokens_collection.insert_one(
        {
            "token_hash": sha256_hex(token),
            "username": username,
            "created_at": utcnow(),
            "expires_at": utcnow() + datetime.timedelta(hours=TOKEN_TTL_HOURS),
        }
    )
    return token


def get_bearer_token():
    parts = request.headers.get("Authorization", "").split()
    if len(parts) == 2 and parts[0].lower() == "bearer" and parts[1]:
        return parts[1]
    return None


def require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        token = get_bearer_token()
        if not token:
            return jsonify({"error": "Authentication required"}), 401
        doc = tokens_collection.find_one(
            {"token_hash": sha256_hex(token), "expires_at": {"$gt": utcnow()}}
        )
        if not doc:
            return jsonify({"error": "Session expired. Please log in again."}), 401
        g.username = doc["username"]
        g.token_hash = doc["token_hash"]
        return fn(*args, **kwargs)

    return wrapper


@app.route("/")
def home():
    return "Backend running"


@app.route("/signup", methods=["POST"])
def signup():
    data = request.get_json(silent=True) or {}
    username = text_field(data, "username", 30)
    fullname = text_field(data, "fullname", 100)
    email = text_field(data, "email", 200).lower()
    role = text_field(data, "role", 60)
    password = data.get("password") if isinstance(data.get("password"), str) else ""

    if not (username and fullname and email and role and password):
        return jsonify({"error": "Please fill in all fields"}), 400
    if not USERNAME_RE.match(username):
        return jsonify({"error": "Username must be 3-30 characters (letters, numbers, . _ -)"}), 400
    if not EMAIL_RE.match(email):
        return jsonify({"error": "Please enter a valid email address"}), 400
    if len(password) < 8 or len(password) > 128:
        return jsonify({"error": "Password must be 8-128 characters"}), 400

    if users_collection.find_one({"username": username}):
        return jsonify({"error": "Username already taken"}), 400
    if users_collection.find_one({"email": email}):
        return jsonify({"error": "Email already registered"}), 400

    try:
        users_collection.insert_one(
            {
                "username": username,
                "password": generate_password_hash(password),
                "fullname": fullname,
                "email": email,
                "target_role": role,
                "join_date": utcnow().isoformat() + "Z",
            }
        )
    except DuplicateKeyError:
        return jsonify({"error": "Username or email already registered"}), 400

    token = create_token(username)
    return jsonify(
        {"message": "Signup successful", "token": token, "username": username, "fullname": fullname}
    )


@app.route("/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    username = text_field(data, "username", 30)
    password = data.get("password") if isinstance(data.get("password"), str) else ""

    user = users_collection.find_one({"username": username}) if username else None
    if not user or not verify_password(user.get("password"), password):
        return jsonify({"error": "Invalid credentials"}), 401

    if is_legacy_hash(user.get("password")):  # upgrade old unsalted hash on successful login
        users_collection.update_one(
            {"_id": user["_id"]}, {"$set": {"password": generate_password_hash(password)}}
        )

    token = create_token(username)
    return jsonify(
        {
            "message": "Login successful",
            "token": token,
            "username": username,
            "fullname": user.get("fullname") or username,
        }
    )


@app.route("/logout", methods=["POST"])
@require_auth
def logout():
    tokens_collection.delete_one({"token_hash": g.token_hash})
    return jsonify({"message": "Logged out"})


# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------
def convert_to_wav(src, dst):
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", src, "-ar", "16000", "-ac", "1", dst],
            capture_output=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise RuntimeError(f"ffmpeg unavailable or timed out: {e}")
    if result.returncode != 0 or not os.path.isfile(dst):
        raise RuntimeError("ffmpeg failed to convert the recording")


def clean_speech_text(text):
    text = re.sub(r"[\x00-\x1f\x7f]", " ", text or "")
    text = re.sub(r"\s+", " ", text).strip().lstrip("-").strip()
    return text[:1000]


def synthesize_speech(text):
    """Return an audio id for the spoken text, or None if TTS is unavailable (frontend then falls back)."""
    text = clean_speech_text(text)
    if not text:
        return None
    cleanup_old_files()
    audio_id = str(uuid.uuid4())
    output_aiff = os.path.join(OUTPUT_FOLDER, f"{audio_id}.aiff")
    output_wav = os.path.join(OUTPUT_FOLDER, f"{audio_id}.wav")
    try:
        # "--" ends option parsing so the text can never be read as a flag.
        subprocess.run(
            ["say", "-v", "Samantha", "-o", output_aiff, "--", text],
            check=True,
            capture_output=True,
            timeout=60,
        )
        subprocess.run(
            ["ffmpeg", "-y", "-i", output_aiff, output_wav],
            check=True,
            capture_output=True,
            timeout=60,
        )
        return audio_id
    except (OSError, subprocess.SubprocessError) as e:
        print("TTS error:", e)
        remove_files(output_wav)
        return None
    finally:
        remove_files(output_aiff)


@app.route("/audio/<audio_id>")
def get_audio(audio_id):
    if not UUID_RE.match(audio_id.lower()):
        return jsonify({"error": "Invalid audio ID"}), 400

    audio_path = os.path.join(OUTPUT_FOLDER, f"{audio_id.lower()}.wav")
    if not os.path.isfile(audio_path):
        return jsonify({"error": "Audio not found"}), 404

    response = send_file(audio_path, mimetype="audio/wav")
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return response


def audio_url_for(audio_id):
    return f"/audio/{audio_id}" if audio_id else None


# ---------------------------------------------------------------------------
# Analysis + scoring
# ---------------------------------------------------------------------------
def analyze_voice(wav_path):
    info = {"emotion": "Professional", "duration": 0.0, "speech_ratio": 0.0, "rms": 0.0}
    try:
        y, sr = librosa.load(wav_path, sr=16000)
        info["duration"] = float(librosa.get_duration(y=y, sr=sr))
        if len(y):
            intervals = librosa.effects.split(y, top_db=30)
            speech_samples = sum(int(end - start) for start, end in intervals)
            info["speech_ratio"] = speech_samples / len(y)
            info["rms"] = float(librosa.feature.rms(y=y).mean())
    except Exception as e:
        print("Audio analysis error:", e)

    try:
        with model_lock:
            predictions = emotion_classifier(wav_path, top_k=1)
        raw_label = str(predictions[0]["label"]).lower()
        info["emotion"] = EMOTION_MAP.get(raw_label, "Professional")
    except Exception as e:
        print("Emotion error:", e)
    return info


def transcribe(wav_path, language_code):
    with model_lock:
        result = whisper_model.transcribe(wav_path, fp16=False, language=language_code)
    text = (result.get("text") or "").strip()
    segments = result.get("segments") or []
    seconds = float(segments[-1]["end"]) if segments else 0.0
    return text, seconds


def score_answer(transcript, duration, voice):
    words = transcript.split()
    word_count = len(words)
    wpm = (word_count / duration) * 60 if duration > 0 else 0

    # Pace: 110-170 words/min is ideal
    if wpm <= 0:
        pace = 0
    elif 110 <= wpm <= 170:
        pace = 100
    elif wpm < 110:
        pace = clamp(100 - (110 - wpm) * 1.5)
    else:
        pace = clamp(100 - (wpm - 170) * 1.2)

    # Filler words: 10% fillers -> 60
    fillers = len(FILLER_PATTERN.findall(transcript))
    filler_rate = fillers / word_count if word_count else 0
    filler = clamp(100 - filler_rate * 400)

    # Voice: how continuously and audibly the candidate spoke
    voice_score = clamp(40 + 60 * min(1.0, voice["speech_ratio"] / 0.85))
    if 0 < voice["rms"] < 0.01:
        voice_score = clamp(voice_score - 15)

    emotion_score = EMOTION_SCORES.get(voice["emotion"], 75)

    # Very short answers can't score as highly
    length_factor = 1.0 if word_count >= 10 else 0.5 + 0.05 * word_count

    confidence = half_up(clamp((0.40 * pace + 0.30 * filler + 0.30 * emotion_score) * length_factor))
    communication = half_up(clamp((0.35 * pace + 0.35 * filler + 0.30 * voice_score) * length_factor))
    return {
        "confidence": confidence,
        "communication": communication,
        "pace_score": half_up(pace),
        "filler_score": half_up(filler),
        "voice_score": half_up(voice_score),
        "emotion_score": half_up(emotion_score),
        "wpm": half_up(wpm),
        "filler_count": fillers,
    }


def summarize_turns(turns):
    if not turns:
        return None
    n = len(turns)
    confidence = half_up(sum(t["confidence"] for t in turns) / n)
    communication = half_up(sum(t["communication"] for t in turns) / n)
    overall = half_up((confidence + communication) / 2)
    emotion = Counter(t["emotion"] for t in turns).most_common(1)[0][0]
    return {
        "turns": n,
        "overall_score": overall,
        "confidence": confidence,
        "communication": communication,
        "emotion": emotion,
    }


def history_text(turns):
    return "".join(
        f"Interviewer: {t['question']}\nCandidate: {t['transcript']}\n\n" for t in turns
    )


def ask_ollama(prompt, timeout):
    try:
        response = requests.post(
            OLLAMA_URL,
            json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False},
            timeout=timeout,
        )
        response.raise_for_status()
        text = clean_speech_text(response.json().get("response") or "")
        return text or None
    except (requests.RequestException, ValueError) as e:
        print("Ollama error:", e)
        return None


def fallback_question(domain):
    """A useful domain-specific fallback when Ollama is unavailable or returns malformed output."""
    questions = {
        "Artificial Intelligence": "How would you evaluate a machine-learning model and decide whether it is ready for deployment?",
        "Data Structures and Algorithms": "How would you choose an appropriate data structure for a lookup-heavy application, and why?",
        "Cybersecurity": "What steps would you take to investigate a suspicious login and limit potential damage?",
        "Web Development": "How would you diagnose a web page that loads slowly for users?",
        "Cloud Computing": "How would you design a cloud service to remain available if one instance fails?",
    }
    return questions.get(domain, "Could you explain how you would solve a practical problem in this area?")


def clean_interviewer_question(text, domain):
    """Keep the model response concise and ensure it contains an actual question."""
    text = clean_speech_text(text).strip(' \"\'`')
    text = re.sub(r"^(?:interviewer|question|response)\s*:\s*", "", text, flags=re.IGNORECASE)
    if not text or "?" not in text:
        return fallback_question(domain)
    # Enforce one question so the interview progresses one prompt at a time.
    text = text[: text.find("?") + 1].strip()
    if len(text) > 500:
        text = text[:500].rsplit(" ", 1)[0]
        if "?" not in text:
            return fallback_question(domain)
    return text


def build_fallback_feedback(summary):
    overall = summary["overall_score"]
    if overall >= 85:
        text = "Outstanding performance! You demonstrated exceptional interview skills with "
    elif overall >= 70:
        text = "Strong performance overall. You showed solid interview skills with "
    else:
        text = "Good effort! You demonstrated basic interview competency with "
    text += f"{summary['emotion'].lower()} energy. "
    if summary["confidence"] >= 80:
        text += "Your confidence level was impressive and consistent. "
    else:
        text += "Work on building more confidence through practice. "
    if summary["communication"] >= 80:
        text += "Your communication was clear and well-structured. "
    else:
        text += "Focus on reducing filler words and speaking more concisely. "
    text += (
        "You're well-prepared for real interviews!"
        if overall >= 80
        else "Keep practicing to improve further."
    )
    return text


# ---------------------------------------------------------------------------
# Interview sessions (all scoring/state lives on the server)
# ---------------------------------------------------------------------------
@app.route("/start-interview", methods=["POST"])
@require_auth
def start_interview():
    data = request.get_json(silent=True) or {}
    domain = text_field(data, "domain", 100)
    difficulty = text_field(data, "difficulty", 20).lower() or "medium"
    mode = text_field(data, "mode", 20).lower() or "video"
    language = text_field(data, "language", 30).lower() or "english"

    if domain not in FIRST_QUESTIONS:
        return jsonify({"error": "Unknown domain"}), 400
    if difficulty not in DIFFICULTIES:
        return jsonify({"error": "Unknown difficulty"}), 400
    if mode not in MODES:
        return jsonify({"error": "Unknown mode"}), 400
    if language not in LANGUAGE_CODES:
        return jsonify({"error": "Unsupported language"}), 400

    question = FIRST_QUESTIONS[domain][difficulty]
    user = users_collection.find_one({"username": g.username}, {"fullname": 1}) or {}
    name = user.get("fullname") or g.username
    spoken_text = f"Welcome {name}, we will begin your interview now. {question}"

    session_id = str(uuid.uuid4())
    sessions_collection.insert_one(
        {
            "_id": session_id,
            "username": g.username,
            "domain": domain,
            "difficulty": difficulty,
            "mode": mode,
            "language": language,
            "status": "active",
            "current_question": question,
            "turns": [],
            "turn_count": 0,
            "created_at": utcnow(),
        }
    )

    audio_id = synthesize_speech(spoken_text)
    return jsonify(
        {
            "session_id": session_id,
            "question": question,
            "spoken_text": spoken_text,
            "audio_url": audio_url_for(audio_id),
            "question_number": 1,
            "total": MAX_QUESTIONS,
        }
    )


@app.route("/process-audio", methods=["POST"])
@require_auth
def process_audio():
    file = request.files.get("audio")
    session_id = request.form.get("session_id", "")
    if not file or not session_id:
        return jsonify({"error": "Audio and session_id are required"}), 400

    session = sessions_collection.find_one({"_id": session_id, "username": g.username})
    if not session:
        return jsonify({"error": "Interview session not found"}), 404
    if session["status"] != "active":
        return jsonify({"error": "This interview has already ended"}), 409

    turn_count = session.get("turn_count", 0)
    request_id = str(uuid.uuid4())
    webm_path = os.path.join(UPLOAD_FOLDER, f"{request_id}.webm")
    wav_path = os.path.join(UPLOAD_FOLDER, f"{request_id}.wav")

    try:
        file.save(webm_path)
        if os.path.getsize(webm_path) == 0:
            return jsonify({"error": "The audio recording was empty"}), 400
        try:
            convert_to_wav(webm_path, wav_path)
        except RuntimeError as e:
            print("Conversion error:", e)
            return jsonify({"error": "Could not process the audio recording"}), 422

        voice = analyze_voice(wav_path)
        try:
            transcript, whisper_seconds = transcribe(wav_path, LANGUAGE_CODES[session["language"]])
        except Exception as e:
            print("Whisper Transcription Error:", e)
            transcript, whisper_seconds = "", 0.0
    finally:
        remove_files(webm_path, wav_path)

    print(f"DEBUG: Whisper heard: '{transcript}'")

    # Silence: don't count it as an answer, don't score it, just ask again.
    no_speech = voice["duration"] > 0 and voice["speech_ratio"] < 0.03
    if len(transcript) < 2 or no_speech:
        audio_id = synthesize_speech(SILENCE_TEXT)
        return jsonify(
            {
                "silent": True,
                "question": session["current_question"],
                "spoken_text": SILENCE_TEXT,
                "audio_url": audio_url_for(audio_id),
                "question_number": turn_count + 1,
                "total": MAX_QUESTIONS,
            }
        )

    duration = voice["duration"] or whisper_seconds
    scores = score_answer(transcript, duration, voice)
    turn = {
        "question": session["current_question"],
        "transcript": transcript,
        "emotion": voice["emotion"],
        "created_at": utcnow().isoformat() + "Z",
        **scores,
    }

    is_last = turn_count + 1 >= MAX_QUESTIONS
    update = {"$push": {"turns": turn}, "$inc": {"turn_count": 1}}
    if is_last:
        update["$set"] = {"status": "completed", "current_question": CLOSING_TEXT}

    # Atomic claim of this turn: a duplicate/concurrent request cannot record it twice.
    claimed = sessions_collection.update_one(
        {"_id": session_id, "username": g.username, "status": "active", "turn_count": turn_count},
        update,
    )
    if claimed.modified_count == 0:
        return jsonify({"error": "This answer was already processed or the interview has ended"}), 409

    base_response = {
        "transcript": transcript,
        "emotion": turn["emotion"],
        "confidence": turn["confidence"],
        "communication": turn["communication"],
        "total": MAX_QUESTIONS,
    }

    if is_last:
        audio_id = synthesize_speech(CLOSING_TEXT)
        return jsonify(
            {
                **base_response,
                "end": True,
                "question": CLOSING_TEXT,
                "spoken_text": CLOSING_TEXT,
                "audio_url": audio_url_for(audio_id),
                "question_number": MAX_QUESTIONS,
            }
        )

    language = session["language"].capitalize()
    prompt = f"""
    You are a professional interviewer conducting a {session['domain']} interview.
    Difficulty: {session['difficulty']}.

    INTERVIEW HISTORY:
    {history_text(session['turns'])}

    CURRENT QUESTION: "{session['current_question']}"
    CANDIDATE'S ANSWER: "{transcript}"

    REQUIREMENTS:
    1. Ask exactly ONE clear, relevant interview question.
    2. Stay strictly within the {session['domain']} domain and the {session['difficulty']} difficulty level.
    3. Ask a specific technical or practical question, not a generic question.
    4. Use the candidate's answer to ask a meaningful follow-up when appropriate.
    5. If the answer is incorrect, briefly correct or challenge it before asking the next question.
    6. If the answer is too short or unclear, briefly acknowledge that and ask a useful follow-up.
    7. Do not repeat any question already asked in the interview history.
    8. Do not invent candidate experience, qualifications, or answers.
    9. Keep the entire response under 50 words.
    10. Output only the spoken response in natural {language}. No labels, lists, or explanations.

    Your response must contain one brief reaction at most, followed by exactly one interview question.
    """
    ai_text = ask_ollama(prompt, timeout=120)
    ai_text = clean_interviewer_question(ai_text or "", session["domain"])

    question_update = sessions_collection.update_one(
        {
            "_id": session_id,
            "username": g.username,
            "status": "active",
            "turn_count": turn_count + 1,
        },
        {"$set": {"current_question": ai_text}},
    )
    if question_update.matched_count == 0:
        return jsonify({"error": "Interview state changed while generating the next question. Please retry or end the interview."}), 409
    audio_id = synthesize_speech(ai_text)
    return jsonify(
        {
            **base_response,
            "end": False,
            "question": ai_text,
            "spoken_text": ai_text,
            "audio_url": audio_url_for(audio_id),
            "question_number": min(turn_count + 2, MAX_QUESTIONS),
        }
    )


@app.route("/end-interview", methods=["POST"])
@require_auth
def end_interview():
    data = request.get_json(silent=True) or {}
    session_id = text_field(data, "session_id", 64)

    session = sessions_collection.find_one({"_id": session_id, "username": g.username})
    if not session:
        return jsonify({"error": "Interview session not found"}), 404
    if session["status"] == "finalized":  # idempotent: repeat calls return the saved result
        return jsonify(session["result"])

    # Atomically claim finalization so two requests can't both save history.
    claimed = sessions_collection.find_one_and_update(
        {"_id": session_id, "username": g.username, "status": {"$in": ["active", "completed"]}},
        {"$set": {"status": "finalizing"}},
        return_document=ReturnDocument.BEFORE,
    )
    if not claimed:
        return jsonify({"error": "This interview is already being finalized"}), 409

    previous_status = claimed["status"]
    try:
        turns = claimed.get("turns", [])
        summary = summarize_turns(turns)

        if not summary:
            result = {
                "turns": 0,
                "overall_score": 0,
                "confidence": 0,
                "communication": 0,
                "emotion": "Professional",
                "feedback": "No answers were recorded, so there is nothing to analyse yet. Try answering at least one question next time.",
            }
        else:
            transcript = history_text(turns)
            prompt = f"""
            You are an expert technical interview coach.
            Review this candidate's entire interview transcript for the {claimed['domain']} domain:
            {transcript}

            Metrics collected during the interview:
            - Dominant Vocal Tone: {summary['emotion']}
            - Confidence Score: {summary['confidence']}/100
            - Communication Score: {summary['communication']}/100

            Write a highly detailed, 3-4 sentence feedback paragraph addressed directly to the candidate (use "you").
            Tell them how their vocal tone ({summary['emotion']}) matched or mismatched their technical answers.
            Give one specific technical strength they showed in the transcript, and one specific area to improve.
            Do not use generic fluff.
            """
            feedback = ask_ollama(prompt, timeout=90) or build_fallback_feedback(summary)
            result = {**summary, "feedback": feedback}

            entry = {
                "session_id": session_id,
                "username": g.username,
                "domain": claimed["domain"],
                "difficulty": claimed["difficulty"],
                "mode": claimed["mode"],
                "overall_score": summary["overall_score"],
                "confidence": summary["confidence"],
                "communication": summary["communication"],
                "emotion": summary["emotion"],
                "feedback": feedback,
                "transcript": transcript,
                "date": utcnow().isoformat() + "Z",
            }
            try:
                history_collection.update_one(
                    {"session_id": session_id}, {"$setOnInsert": entry}, upsert=True
                )
            except DuplicateKeyError:
                pass  # another request already saved this interview

        sessions_collection.update_one(
            {"_id": session_id}, {"$set": {"status": "finalized", "result": result}}
        )
        return jsonify(result)
    except Exception as e:
        print("Finalize error:", e)
        sessions_collection.update_one(
            {"_id": session_id, "status": "finalizing"}, {"$set": {"status": previous_status}}
        )
        return jsonify({"error": "Could not finalize the interview. Please try again."}), 500


# ---------------------------------------------------------------------------
# Profile + history (own data only)
# ---------------------------------------------------------------------------
@app.route("/get-profile/<username>", methods=["GET"])
@require_auth
def get_profile(username):
    if username != g.username:
        return jsonify({"error": "Forbidden"}), 403

    user = users_collection.find_one({"username": username}, {"_id": 0, "password": 0})
    if not user:
        return jsonify({"error": "User not found"}), 404

    scores = [
        h.get("overall_score") or 0
        for h in history_collection.find({"username": username}, {"overall_score": 1})
    ]
    user["total_interviews"] = len(scores)
    user["avg_score"] = half_up(sum(scores) / len(scores)) if scores else 0
    return jsonify(user)


@app.route("/get-history/<username>", methods=["GET"])
@require_auth
def get_history(username):
    if username != g.username:
        return jsonify({"error": "Forbidden"}), 403

    entries = list(
        history_collection.find({"username": username}, {"_id": 0}).sort("date", -1)
    )
    return jsonify(entries)


if __name__ == "__main__":
    app.run(debug=False, threaded=True)
