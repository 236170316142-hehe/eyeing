#!/usr/bin/env python3
"""
Employee Activity Monitor
Monitors active window, takes screenshots, performs OCR, and generates JSON reports.
"""

import io
import os
import sys
import re
import json
import time
import signal
import logging
import subprocess
import hashlib
import socket
import threading
import traceback
import webbrowser
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# ── Optional imports ────────────────────────────────────────────────────────
try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

try:
    import win32gui
    import win32process
    HAS_WIN32 = True
except ImportError:
    HAS_WIN32 = False

try:
    import pyautogui
    HAS_PYAUTOGUI = True
except ImportError:
    HAS_PYAUTOGUI = False

try:
    from PIL import Image, ImageEnhance, ImageFilter, ImageOps
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    import pytesseract
    HAS_PYTESSERACT = True
except ImportError:
    HAS_PYTESSERACT = False



try:
    import pyperclip
    HAS_PYPERCLIP = True
except ImportError:
    HAS_PYPERCLIP = False

try:
    from pynput import keyboard as _kb, mouse as _mouse
    HAS_PYNPUT = True
except ImportError:
    HAS_PYNPUT = False

# NVIDIA API for Cloud Embeddings
NVIDIA_API_KEY = None
try:
    with open(Path(__file__).parent / "backend" / ".env", "r") as f:
        for line in f:
            if line.startswith("NVIDIA_API_KEY="):
                NVIDIA_API_KEY = line.split("=")[1].strip()
except Exception:
    pass

# ── Constants ────────────────────────────────────────────────────────────────
BASE_DIR        = Path(__file__).parent.absolute()
DATA_DIR        = BASE_DIR / "activity_data"
SCREENSHOTS_DIR = DATA_DIR / "screenshots"
OCR_DIR         = DATA_DIR / "ocr_text"
REPORTS_DIR     = DATA_DIR / "reports"
CONFIG_FILE     = DATA_DIR / "config.json"
BACKEND_URL_FILE = BASE_DIR / "backend_url.txt"
LOG_FILE        = str(BASE_DIR / "activity_monitor.log")
POLL_INTERVAL = 2.0    # interval in seconds
REPORT_INTERVAL = 120  # interval in seconds
IDLE_TIMEOUT_SECONDS = 300
RESUME_REPORT_GRACE_SECONDS = 2

BACKEND_URL = "http://localhost:3000" # Change this to your live server's IP/Domain when deploying!

BROWSER_APPS = {"chrome", "firefox", "msedge", "brave", "opera"}

APP_MAP = {
    "chrome":     "Chrome",
    "firefox":    "Firefox",
    "msedge":     "Edge",
    "brave":      "Brave",
    "opera":      "Opera",
    "safari":     "Safari",
    "code":       "VS Code",
    "opencode":   "VS Code",
    "pycharm":    "PyCharm",
    "idea":       "IntelliJ IDEA",
    "sublime":    "Sublime Text",
    "atom":       "Atom",
    "notepad":    "Notepad",
    "wordpad":    "WordPad",
    "winword":    "Microsoft Word",
    "excel":      "Microsoft Excel",
    "powerpnt":   "Microsoft PowerPoint",
    "outlook":    "Microsoft Outlook",
    "teams":      "Microsoft Teams",
    "slack":      "Slack",
    "discord":    "Discord",
    "zoom":       "Zoom",
    "explorer":   "File Explorer",
    "cmd":        "Command Prompt",
    "powershell": "PowerShell",
    "python":     "Python",
    "node":       "Node.js",
    "terminal":   "Terminal",
    "postman":    "Postman",
    "figma":      "Figma",
    "obsidian":   "Obsidian",
    "notion":     "Notion",
}


# ── Helpers ──────────────────────────────────────────────────────────────────
def _confidence_label(confidence: float) -> str:
    """Human-readable quality label for an OCR mean-confidence score."""
    if confidence >= 90:
        return "Excellent (>=90%)"
    elif confidence >= 75:
        return "Good (75-89%)"
    elif confidence >= 55:
        return "Fair (55-74%)"
    elif confidence > 0:
        return "Poor (<55%)"
    else:
        return "No text detected"


def _setup_logging():
    fmt  = "%(asctime)s - %(levelname)s - %(message)s"
    root = logging.getLogger()
    if root.handlers:
        return
    root.setLevel(logging.INFO)
    fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
    fh.setFormatter(logging.Formatter(fmt))
    root.addHandler(fh)
    if sys.stdout is not None:
        try:
            safe_stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
            sh = logging.StreamHandler(safe_stdout)
            sh.setFormatter(logging.Formatter(fmt))
            root.addHandler(sh)
        except Exception:
            pass


def _resolve_backend_url(config: dict | None = None) -> str:
    """Resolve backend URL in this priority: config -> env -> file -> default."""
    env_value = str(os.environ.get("MONITOR_BACKEND_URL", "")).strip()
    if env_value:
        return env_value.rstrip('/')

    if BACKEND_URL_FILE.exists():
        try:
            file_value = BACKEND_URL_FILE.read_text(encoding="utf-8").strip()
            if file_value:
                return file_value.rstrip('/')
        except Exception:
            pass

    if config:
        candidate = str(config.get("backend_url") or "").strip()
        if candidate:
            normalized = candidate.rstrip('/')
            if not normalized.startswith('http://localhost') and not normalized.startswith('http://127.0.0.1'):
                return normalized

    return BACKEND_URL.rstrip('/')


def _run_onboarding_if_needed():
    """Open the web setup page on first run so onboarding stays browser-based."""
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                if cfg.get("employee_id") and cfg.get("company_id") and cfg.get("user_id") and cfg.get("login_email") and cfg.get("designation"):
                    print("[BOOT] Config found. Skipping setup.")
                    return
        except Exception as e:
            print("[BOOT] Config read error.")

    try:
        setup_url = f"{_resolve_backend_url()}/setup.html"
        webbrowser.open(setup_url)
        print(f"[BOOT] Opened web setup page: {setup_url}")
    except Exception as exc:
        print(f"[BOOT] Could not open web setup page: {exc}")


def _load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    hostname = socket.gethostname()
    short = hashlib.md5(hostname.encode()).hexdigest()[:6].upper()
    return {
        "employee_id": f"EMP_{short}",
        "company_id":  "ACME_001",
        "org_name":    "DEFAULT_ORG",
        "user_id":     "DEFAULT_USER",
        "login_email": "",
        "designation": "",
        "login_provider": "email",
        "backend_url": _resolve_backend_url(),
        "device_id":   hostname,
    }


# ════════════════════════════════════════════════════════════════════════════
class ActivityMonitor:
    """Monitors employee activity: window focus, screenshots, OCR, JSON reports."""

    def __init__(self):
        # Disable experimental PIR engine to prevent C++ crashes on some CPUs
        os.environ["FLAGS_enable_pir_api"] = "0"
        
        # Atomic shutdown guard (threading.Event.set() is thread-safe)
        self._shutdown_event = threading.Event()

        _setup_logging()
        self.log = logging.getLogger(__name__)

        # Show browser-based setup on first run.
        _run_onboarding_if_needed()

        # Load config ONCE
        cfg = _load_config()
        self.employee_id     = cfg.get("employee_id", "UNKNOWN")
        self.company_id      = cfg.get("company_id",  "UNKNOWN")
        self.org_name        = cfg.get("org_name",    "UNKNOWN")
        self.user_id         = cfg.get("user_id",     "UNKNOWN")
        self.designation     = cfg.get("designation", "")
        self.device_id       = cfg.get("device_id",   socket.gethostname())
        self.backend_url     = _resolve_backend_url(cfg)
        self._app_overrides: dict = cfg.get("app_name_overrides", {})
        
        # Adjustable via Remote Admin
        self._report_interval = REPORT_INTERVAL 

        # NVIDIA Embeddings Setup
        self.use_nvidia_api = (NVIDIA_API_KEY is not None and "nvapi-" in NVIDIA_API_KEY)
        if self.use_nvidia_api:
            self.log.info("NVIDIA Embedding API enabled.")
        else:
            self.log.warning("NVIDIA_API_KEY missing or invalid in backend/.env. Embeddings disabled.")

        # Ensure data directories
        for d in (DATA_DIR, SCREENSHOTS_DIR, OCR_DIR, REPORTS_DIR):
            d.mkdir(parents=True, exist_ok=True)

        self.log.info("Starting Employee Activity Monitor...")
        self.log.info(f"Employee ID: {self.employee_id}")
        self.log.info(f"Company ID:  {self.company_id}")
        self.log.info(f"Backend URL: {self.backend_url}")
        self.log.info(f"Reports will be saved to: {DATA_DIR}")
        self.log.info(f"Logging interval: {REPORT_INTERVAL} seconds")

        # Runtime state
        self._running        = True
        self._report_counter = 0
        self._last_report_ts = time.time()
        self._tracking_paused = False
        self._capture_pipeline_enabled = True
        self._ocr_pipeline_enabled = True
        self._embedding_pipeline_enabled = True
        
        # Load Tesseract if available
        if HAS_PYTESSERACT:
            p = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
            if os.path.exists(p):
                pytesseract.pytesseract.tesseract_cmd = p
                self.log.info(f"Tesseract engine linked: {p}")
            else:
                self.log.warning(f"Tesseract NOT found at {p}. Trying fallback search...")
                tess_paths = [
                    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
                    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Tesseract-OCR", "tesseract.exe"),
                ]
                for p_auto in tess_paths:
                    if os.path.exists(p_auto):
                        pytesseract.pytesseract.tesseract_cmd = p_auto
                        self.log.info(f"Tesseract found: {p_auto}")
                        break
                else:
                    self.log.error("Tesseract engine NOT found. OCR will be disabled.")

        # App-time tracking: app_name → seconds active this interval
        self._app_time: dict[str, float] = defaultdict(float)

        # Best known window info (sticky — only updated when non-empty/non-Unknown)
        self._best_app   = "Unknown"
        self._best_title = ""
        self._best_url   = ""

        # Per-interval accumulators
        self._active_secs = 0.0
        self._idle_secs   = 0.0

        # Clipboard
        self._clipboard_copies  = 0
        self._clipboard_pastes  = 0
        self._clipboard_cuts    = 0
        self._clipboard_src_apps = []
        self._clipboard_dst_apps = []
        self._prev_clip         = ""

        # Keyboard / mouse (updated by pynput listeners)
        self._key_press_count   = 0
        self._key_burst_count   = 0
        self._last_key_ts       = 0.0
        self._mouse_click_count = 0
        self._keyboard_active   = False
        self._mouse_active      = False

        # App-switch tracking
        self._prev_app        = None
        self._app_switches    = 0
        self._switch_sequence: list[str] = []
        
        # Idle tracking
        self._last_activity_ts = time.time()
        self._is_paused_by_idle = False

        self._lock = threading.Lock()

        signal.signal(signal.SIGINT,  self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)

        self._start_input_listeners()

    # ── Signal handling ──────────────────────────────────────────────────────
    def _handle_signal(self, signum, frame):
        """Fire exactly once — threading.Event.set() is atomic across all threads."""
        if self._shutdown_event.is_set():
            return
        self._shutdown_event.set()
        self._running = False
        self.log.info("Received shutdown signal — taking final snapshot...")
        self._take_screenshot_and_ocr()

    # ── pynput listeners ─────────────────────────────────────────────────────
    def _start_input_listeners(self):
        """Start background keyboard + mouse listeners via pynput."""
        if not HAS_PYNPUT:
            self.log.warning("pynput not available — keyboard/mouse tracking disabled. "
                             "Install with: pip install pynput")
            return

        _ctrl_held = {"left": False, "right": False}

        def on_key_press(key):
            with self._lock:
                now = time.time()
                self._keyboard_active = True
                self._key_press_count += 1
                self._last_activity_ts = now # Activity detected!
                if now - self._last_key_ts < 2.0:
                    if self._key_press_count % 5 == 0:
                        self._key_burst_count += 1
                self._last_key_ts = now
                try:
                    if key in (_kb.Key.ctrl_l, _kb.Key.ctrl):
                        _ctrl_held["left"] = True
                    elif key == _kb.Key.ctrl_r:
                        _ctrl_held["right"] = True
                except Exception:
                    pass

        def on_key_release(key):
            with self._lock:
                try:
                    ctrl = _ctrl_held["left"] or _ctrl_held["right"]
                    is_c = False; is_v = False; is_x = False

                    if hasattr(key, "char") and key.char:
                        ch = key.char.lower()
                        if ch == "c" or ch == "\x03": is_c = True
                        if ch == "v" or ch == "\x16": is_v = True
                        if ch == "x" or ch == "\x18": is_x = True
                    elif hasattr(key, "vk") and key.vk:
                        if key.vk == 67: is_c = True
                        if key.vk == 86: is_v = True
                        if key.vk == 88: is_x = True

                    if ctrl:
                        app = self._best_app
                        if is_c:
                            self._clipboard_copies += 1
                            if app not in self._clipboard_src_apps:
                                self._clipboard_src_apps.append(app)
                        elif is_x:
                            self._clipboard_cuts += 1
                            if app not in self._clipboard_src_apps:
                                self._clipboard_src_apps.append(app)
                        elif is_v:
                            self._clipboard_pastes += 1
                            if app not in self._clipboard_dst_apps:
                                self._clipboard_dst_apps.append(app)
                    if key in (_kb.Key.ctrl_l, _kb.Key.ctrl):
                        _ctrl_held["left"] = False
                    elif key == _kb.Key.ctrl_r:
                        _ctrl_held["right"] = False
                except Exception:
                    pass

        def on_mouse_click(x, y, button, pressed):
            if pressed:
                with self._lock:
                    self._mouse_active = True
                    self._mouse_click_count += 1
                    self._last_activity_ts = time.time() # Activity detected!

        try:
            kb_listener = _kb.Listener(on_press=on_key_press,
                                       on_release=on_key_release, daemon=True)
            ms_listener = _mouse.Listener(on_click=on_mouse_click, daemon=True)
            kb_listener.start()
            ms_listener.start()
            self.log.info("Keyboard and mouse listeners started (pynput)")
        except Exception as e:
            self.log.warning(f"Could not start pynput listeners: {e}")

    # ── URL extraction ───────────────────────────────────────────────────────
    def _extract_url(self, title: str) -> str:
        if not title:
            return ""
        match = re.search(r"https?://[^\s<>\"]+|www\.[^\s<>\"]+", title)
        return match.group(0) if match else ""

    # ── OCR image preprocessing ───────────────────────────────────────────────
    def _preprocess_for_ocr(self, img):
        """
        5-step pipeline for 95%+ confidence on screen captures.
        """
        # 1. Normalise to RGB
        if img.mode == "RGBA":
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[3])
            img = bg
        elif img.mode != "RGB":
            img = img.convert("RGB")

        # 2. 2× Upscale (very important for screen text)
        w, h = img.size
        img = img.resize((w * 2, h * 2), Image.LANCZOS)

        # 3. Grayscale
        img = img.convert("L")

        # 4. High Contrast
        img = ImageEnhance.Contrast(img).enhance(2.5)

        # 5. Sharpen + Binarise
        img = img.filter(ImageFilter.UnsharpMask(radius=2, percent=150, threshold=3))
        img = ImageOps.autocontrast(img, cutoff=1)
        img = img.point(lambda p: 255 if p > 130 else 0)
        return img



    # ── Active window detection ──────────────────────────────────────────────
    def _get_all_open_windows(self) -> list[str]:
        """Returns a list of titles of all visible application windows."""
        if not HAS_WIN32:
            return []
        windows = []
        def enum_handler(hwnd, ctx):
            try:
                if win32gui.IsWindowVisible(hwnd):
                    title = win32gui.GetWindowText(hwnd).strip()
                    if title and title not in ["Program Manager", "Settings", "Microsoft Text Input Application"]:
                        windows.append(title)
            except Exception:
                pass
        try:
            win32gui.EnumWindows(enum_handler, None)
        except Exception:
            pass
        return windows

    def _get_active_window_info(self) -> tuple[str, str, str]:
        if not HAS_WIN32:
            return "Unknown", "", ""
        try:
            hwnd = win32gui.GetForegroundWindow()
            if not hwnd:
                return "Unknown", "", ""

            title    = win32gui.GetWindowText(hwnd) or ""
            app_name = "Unknown"

            try:
                _, pid = win32process.GetWindowThreadProcessId(hwnd)
                if HAS_PSUTIL and pid:
                    proc      = psutil.Process(pid)
                    proc_name = proc.name()
                    base      = proc_name.replace(".exe", "").replace(".EXE", "")
                    lower     = base.lower()

                    for key, friendly in APP_MAP.items():
                        if key in lower:
                            app_name = friendly
                            break
                    else:
                        app_name = base

                    for pat, friendly in self._app_overrides.items():
                        if pat.lower() in lower:
                            app_name = friendly
                            break
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            except Exception:
                pass

            url = ""
            if any(b in app_name.lower() for b in BROWSER_APPS):
                url = self._extract_url(title)

            self.log.info(f"[WINDOW] app='{app_name}' title='{title[:80]}' url='{url}'")
            return app_name, title, url

        except Exception as exc:
            self.log.debug(f"[WINDOW] failed: {exc}")
            return "Unknown", "", ""

    # ── Screenshot + OCR ─────────────────────────────────────────────────────
    def _take_screenshot_and_ocr(self) -> tuple[str, float, int]:
        """Captures screen and extracts text using Tesseract with Preprocessing."""
        if not self._capture_pipeline_enabled:
            self.log.debug("[PIPELINE] Capture disabled, skipping screenshot/OCR.")
            return "", 0.0, 0

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        img_path = SCREENSHOTS_DIR / f"screenshot_{ts}.png"
        
        try:
            raw_img = pyautogui.screenshot()
            raw_img.save(img_path)
            self.log.info(f"Screenshot saved: {img_path}")
        except Exception as e:
            self.log.error(f"Screenshot failed: {e}")
            return "", 0.0, 0

        full_text = ""
        ocr_confidence = 0.0
        word_count = 0

        if HAS_PYTESSERACT and pytesseract.pytesseract.tesseract_cmd:
            try:
                # Apply 5-step preprocessing for "Perfect" accuracy
                # Focus: Brightness, Sharpness, Binarization
                if not self._ocr_pipeline_enabled:
                    self.log.debug("[PIPELINE] OCR disabled, skipping text extraction.")
                    return "", 0.0, 0

                proc_img = self._preprocess_for_ocr(raw_img)
                
                # Perform OCR
                data = pytesseract.image_to_data(proc_img, output_type=pytesseract.Output.DICT)
                
                texts = []
                confs = []
                for i in range(len(data['text'])):
                    word = data['text'][i].strip()
                    if word:
                        texts.append(word)
                        confs.append(float(data['conf'][i]))
                
                full_text = " ".join(texts)
                ocr_confidence = round(sum(confs) / len(confs), 2) if confs else 0.0
                word_count = len(texts)
                snippet = (full_text[:50] + "...") if len(full_text) > 50 else full_text
                self.log.info(f"OCR Detected: '{snippet}' (conf: {ocr_confidence}%, words: {word_count})")
            except Exception as e:
                self.log.error(f"Tesseract fallback failed: {e}")
        
        # Cleanup
        if img_path.exists():
            try:
                img_path.unlink()
            except Exception:
                pass
            
        return full_text, ocr_confidence, word_count
    
    def _get_nvidia_embedding(self, text: str) -> list[float]:
        """Fetch embedding from NVIDIA Cloud NIM API."""
        if not self._embedding_pipeline_enabled:
            self.log.debug("[PIPELINE] Embeddings disabled, skipping NVIDIA request.")
            return []

        import urllib.request
        import json
        if not text: return []
        
        url = "https://integrate.api.nvidia.com/v1/embeddings"
        payload = {
            "input": [text],
            "model": "nvidia/nv-embedqa-e5-v5",
            "input_type": "query",
            "encoding_format": "float"
        }
        headers = {
            "Authorization": f"Bearer {NVIDIA_API_KEY}",
            "Content-Type": "application/json"
        }
        
        try:
            req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers)
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode())
                return data["data"][0]["embedding"]
        except Exception as e:
            self.log.warning(f"NVIDIA Embedding failed: {e}")
            return []
    def _dominant_app(self) -> str:
        if not self._app_time:
            return self._best_app
        return max(self._app_time, key=lambda k: self._app_time[k])  # type: ignore

    def _set_idle_state(self, is_idle: bool) -> None:
        """Update pipeline flags when the user becomes idle or active again."""
        if is_idle == self._is_paused_by_idle:
            return

        self._is_paused_by_idle = is_idle
        self._capture_pipeline_enabled = not is_idle
        self._ocr_pipeline_enabled = not is_idle
        self._embedding_pipeline_enabled = not is_idle

        if is_idle:
            self.log.info("[IDLE] No activity for 5 mins. Pausing OCR, embeddings, and report capture.")
        else:
            self.log.info("[RESUME] Activity detected. Resuming OCR, embeddings, and report capture.")
            self._last_report_ts = time.time() - max(0, self._report_interval - RESUME_REPORT_GRACE_SECONDS)

    def _save_report(self, ocr_text: str, ocr_confidence: float, ocr_word_count: int):
        self._report_counter += 1
        ts    = datetime.now().strftime("%Y%m%d_%H%M%S")
        fname = REPORTS_DIR / f"report_{self._report_counter}_{ts}.json"

        dominant_app  = self._dominant_app()
        app_breakdown = {
            app: round(secs, 1)
            for app, secs in sorted(
                self._app_time.items(), key=lambda x: x[1], reverse=True
            )
        }

        with self._lock:
            open_wins = self._get_all_open_windows()

            report = {
                "employee_id":          self.employee_id,
                "company_id":           self.company_id,
                "org_name":             self.org_name,
                "user_id":              self.user_id,
                "designation":          self.designation,
                "device_id":            self.device_id,
                "timestamp":            datetime.now().astimezone().isoformat(timespec="seconds"),
                # ── Window ──────────────────────────────────────────────────
                "active_app":           dominant_app,
                "window_title":         self._best_title,
                "tab_url":              self._best_url,
                # ── Time ────────────────────────────────────────────────────
                "time_active_sec":      round(self._active_secs, 2),
                "time_idle_sec":        round(self._idle_secs, 2),
                "app_time_breakdown":   app_breakdown,
                # ── Clipboard ───────────────────────────────────────────────
                "clipboard_copies":     self._clipboard_copies,
                "clipboard_pastes":     self._clipboard_pastes,
                "clipboard_cuts":       self._clipboard_cuts,
                "clipboard_source_apps": self._clipboard_src_apps,
                "clipboard_dest_apps":   self._clipboard_dst_apps,
                # ── Keyboard ────────────────────────────────────────────────
                "keyboard_active":      self._keyboard_active,
                "keyboard_key_presses": self._key_press_count,
                "keyboard_bursts":      self._key_burst_count,
                # ── Mouse ────────────────────────────────────────────────────
                "mouse_active":         self._mouse_active,
                "mouse_clicks":         self._mouse_click_count,
                # ── App switches ─────────────────────────────────────────────
                "app_switches":         self._app_switches,
                "switch_sequence":      self._switch_sequence[-10:],
                # ── OCR ──────────────────────────────────────────────────────
                "ocr_confidence_mean":  ocr_confidence,
                "ocr_confidence_label": _confidence_label(ocr_confidence),
                "ocr_word_count":       ocr_word_count,
                "ocr_word_count":       ocr_word_count,
                "ocr_text":             ocr_text,
                "ocr_embedding":        self._get_nvidia_embedding(ocr_text) if self.use_nvidia_api and ocr_text else [],
                # ── Browser tabs / Open Windows ──────────────────────────────
                "open_tabs":            open_wins,
                "browser_tabs_count":   len(open_wins),
            }

            # Reset accumulators
            self._app_time.clear()
            self._active_secs       = 0.0
            self._idle_secs         = 0.0
            self._clipboard_copies  = 0
            self._clipboard_pastes  = 0
            self._clipboard_cuts    = 0
            self._clipboard_src_apps = []
            self._clipboard_dst_apps = []
            self._keyboard_active   = False
            self._key_press_count   = 0
            self._key_burst_count   = 0
            self._mouse_active      = False
            self._mouse_click_count = 0
            self._app_switches      = 0
            self._switch_sequence   = []

        with open(fname, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        self.log.info(f"Report saved locally: {fname}")
        
        # Attempt to flush the backlog (this handles both the new report and any failed past reports)
        self._flush_backlog()

    def _record_elapsed_time(self, elapsed_seconds: float, app_name: str) -> None:
        """Accumulate active or idle time for the current polling cycle."""
        with self._lock:
            if app_name != "Unknown":
                self._app_time[app_name] += elapsed_seconds
                self._active_secs += elapsed_seconds
            else:
                self._idle_secs += elapsed_seconds

    def _check_remote_authorization(self):
        """Poll the backend. Returns (should_track: bool, is_decommissioned: bool, report_interval: int)."""
        import urllib.request
        import urllib.parse
        import json
        try:
            params = urllib.parse.urlencode({'company_id': self.company_id, 'user_id': self.user_id})
            url = f"{self.backend_url}/api/tracking-status?{params}"
            req = urllib.request.Request(url, headers={'User-Agent': 'EmployeeMonitor/1.0'})
            with urllib.request.urlopen(req, timeout=5) as response:
                if response.getcode() == 200:
                    data = json.loads(response.read().decode('utf-8'))
                    return (
                        data.get("is_tracking_active", True), 
                        data.get("is_decommissioned", False),
                        int(data.get("report_interval", 120))
                    )
        except Exception as e:
            self.log.debug(f"Could not reach remote authorization server, defaulting to ACTIVE: {e}")
        return True, False, 120  # Default: active, not decommissioned, 2min interval

    def _self_destruct(self):
        """Permanently remove all traces of the monitor from this PC."""
        import shutil
        import urllib.request
        import json
        self.log.info("[DECOMMISSION] Remote uninstall triggered. Starting self-destruct sequence...")

        # 0. Send final confirmation to backend to wipe all cloud data
        try:
            req = urllib.request.Request(
                f'{self.backend_url}/api/tracker/confirm-deletion',
                data=json.dumps({"company_id": self.company_id, "user_id": self.user_id}).encode('utf-8'),
                headers={'Content-Type': 'application/json', 'User-Agent': 'EmployeeMonitor/1.0'}
            )
            with urllib.request.urlopen(req, timeout=10) as response:
                if response.getcode() == 200:
                    self.log.info("[DECOMMISSION] Cloud data wipe confirmed.")
        except Exception as e:
            self.log.warning(f"[DECOMMISSION] Could not notify backend of deletion: {e}")
        
        # 1. Remove Windows Startup VBS entry
        try:
            startup_folder = os.path.join(os.environ['APPDATA'], 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
            vbs_path = os.path.join(startup_folder, 'EmployeeMonitor.vbs')
            if os.path.exists(vbs_path):
                os.remove(vbs_path)
                self.log.info("[DECOMMISSION] Startup entry removed.")
        except Exception as e:
            self.log.warning(f"[DECOMMISSION] Could not remove startup entry: {e}")

        # 2. Remove folder protection so deletion works
        folder_path = os.path.abspath(os.path.dirname(__file__) or '.')
        try:
            username = os.environ.get('USERNAME', '')
            subprocess.run(['icacls', folder_path, '/remove:d', username], capture_output=True)
            subprocess.run(['attrib', '-h', '-s', folder_path], capture_output=True)
        except Exception:
            pass

        # 3. Self-delete: schedule deletion of entire folder after process exits
        # The bat script needs to handle Unicode paths (like emoji) and spaces safely.
        # rd /s /q has issues natively with emojis through python Popen. Use powershell string for extreme reliability.
        script = f'''@echo off
timeout /t 3 /nobreak >nul
powershell -Command "Remove-Item -Path '{folder_path}' -Recurse -Force"
'''
        bat_path = os.path.join(os.environ.get('TEMP', 'C:\\Temp'), '_em_cleanup.bat')
        try:
            with open(bat_path, 'w', encoding='utf-8') as f:
                f.write(script)
            subprocess.Popen(['cmd.exe', '/c', bat_path], creationflags=0x08000000)  # DETACHED
            self.log.info("[DECOMMISSION] Self-destruct scheduled. Exiting now.")
        except Exception as e:
            self.log.error(f"[DECOMMISSION] Could not schedule deletion: {e}")
        
        # 4. Stop the monitor immediately
        self._running = False
        sys.exit(0)

    def _upload_report(self, payload: dict, filepath) -> bool:
        import urllib.request
        import json
        from pathlib import Path
        
        req = urllib.request.Request(
            f'{self.backend_url}/api/reports',
            data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'User-Agent': 'EmployeeMonitor/1.0'}
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                if response.getcode() in [200, 201]:
                    self.log.info(f"Successfully uploaded {filepath} to backend DB.")
                    # Delete the local file now that it is safely in MongoDB
                    if isinstance(filepath, Path) and filepath.exists():
                        filepath.unlink()
                    elif isinstance(filepath, str) and Path(filepath).exists():
                        Path(filepath).unlink()
                    return True
        except Exception as e:
            self.log.warning(f"Failed to upload report to backend DB: {e}")
        return False
        
    def _flush_backlog(self):
        import json
        import shutil
        from pathlib import Path
        
        # Ensure the 'sending' folder exists (atomic lock directory)
        sending_dir = DATA_DIR / "sending"
        sending_dir.mkdir(parents=True, exist_ok=True)

        # Retry both fresh reports and any stale files left in the sending queue.
        backlog_files = list(REPORTS_DIR.glob("report_*.json")) + list(sending_dir.glob("report_*.json"))
        for old_file in backlog_files:
            try:
                locked_file = old_file
                moved_from_reports = old_file.parent == REPORTS_DIR

                # ATOMIC MOVE: Try to move fresh reports into the sending folder.
                # If another process/thread already moved it, skip safely.
                if moved_from_reports:
                    locked_file = sending_dir / old_file.name
                    if locked_file.exists():
                        continue
                    shutil.move(str(old_file), str(locked_file))

                # Read the payload after the file handle is closed so upload can delete it on success.
                with open(locked_file, 'r', encoding='utf-8') as f:
                    payload = json.load(f)
                
                # Attempt upload. _upload_report will handle deleting locked_file on success
                success = self._upload_report(payload, locked_file)
                
                # If upload failed for a fresh report, move it back to REPORTS_DIR for later.
                if not success and moved_from_reports and locked_file.exists():
                    shutil.move(str(locked_file), str(old_file))
            except Exception:
                # File likely gone or being moved by another thread — skip safely
                pass

    # ── Main loop ────────────────────────────────────────────────────────────
    def run(self):
        """Main monitoring loop."""
        
        # --- Immediate startup auth check: get admin-configured interval BEFORE first report ---
        should_track, is_decommissioned, remote_interval = self._check_remote_authorization()
        if is_decommissioned:
            self._self_destruct()
            return
        if remote_interval != self._report_interval:
            self.log.info(f"[CONFIG] Startup: admin interval is {remote_interval}s (was defaulting to {self._report_interval}s)")
            self._report_interval = remote_interval
        # Reset the report clock so the first report fires exactly `_report_interval` seconds from now
        self._last_report_ts = time.time()
        last_auth_check_ts = time.time()

        while self._running:
            loop_start = time.time()
            
            # 1. Check Kill-Switch / Admin API (Poll every 15 seconds for fast sync)
            if loop_start - last_auth_check_ts >= 15:
                should_track, is_decommissioned, remote_interval = self._check_remote_authorization()
                last_auth_check_ts = loop_start
                
                # Apply remote interval — reset timer so new interval counts from NOW
                if remote_interval != self._report_interval:
                    self.log.info(f"[CONFIG] Remote admin changed report interval from {self._report_interval}s to {remote_interval}s")
                    self._report_interval = remote_interval
                    self._last_report_ts = loop_start  # restart the clock with the new interval
                
                # Decommission takes highest priority — self-destruct immediately
                if is_decommissioned:
                    self._self_destruct()
                    return
                
                # If paused, clear any latent data we held
                if not should_track:
                    with self._lock:
                        self._app_time.clear()
                        self._active_secs = 0.0
                        self._idle_secs = 0.0
                        self._clipboard_copies = 0
                        self._key_press_count = 0
                        self._mouse_click_count = 0

            # 2. If Admin Disabled -> ONLY sleep and loop (strictly NO tracking)
            if not should_track:
                self.log.debug("[KILL-SWITCH] Tracking is paused. Script sleeping...")
                # Reset the report timer so it doesn't instantly fire when turned back on
                self._last_report_ts = loop_start 
                time.sleep(POLL_INTERVAL)
                continue

            # 2.1 Check for System Idle (5 mins no activity)
            idle_time = time.time() - self._last_activity_ts
            if idle_time > IDLE_TIMEOUT_SECONDS:
                self._set_idle_state(True)

                elapsed = time.time() - loop_start
                self._record_elapsed_time(max(elapsed, POLL_INTERVAL), "Unknown")

                # Reset clock so idle periods do not instantly trigger a report on resume
                self._last_report_ts = loop_start
                time.sleep(POLL_INTERVAL)
                continue
            else:
                self._set_idle_state(False)

            # 3. IF ACTIVE -> Resume normal tracking workflows
            # Poll active window
            app, title, url = self._get_active_window_info()

            with self._lock:
                if app != "Unknown":
                    if self._prev_app is not None and app != self._prev_app:
                        self._app_switches += 1
                        self._switch_sequence.append(app)
                    self._prev_app = app
                    self._best_app = app
                    if title:
                        self._best_title = title
                    if url:
                        self._best_url = url

            # Accumulate real elapsed time
            elapsed     = time.time() - loop_start
            actual_poll = max(elapsed, 0.01)

            self._record_elapsed_time(actual_poll, app)

            # Report due?
            now = time.time()
            if not self._is_paused_by_idle and now - self._last_report_ts >= self._report_interval:
                ocr_text, ocr_conf, ocr_wc = self._take_screenshot_and_ocr()
                self._save_report(ocr_text, ocr_conf, ocr_wc)
                self._last_report_ts = now

            # Sleep remainder of poll interval
            used = time.time() - loop_start
            time.sleep(max(0.0, POLL_INTERVAL - used))

        self.log.info("Monitor stopped.")


# ── Entry point ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    try:
        monitor = ActivityMonitor()
        monitor.run()
    except KeyboardInterrupt:
        pass   # already handled by _handle_signal; suppress traceback
    sys.exit(0)
