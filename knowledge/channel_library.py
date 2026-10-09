"""Channel imports, persistent caption storage and Supermemory-backed browser search."""
from __future__ import annotations

import json
import os
from pathlib import Path
import threading
import time

from .caption_answers import answer_captions
from .evidence_answers import answer_from_evidence
from .video_guide import recommend_moments
from .channel_store import ChannelStore
from .ingest import read_json, write_json
from .import_budget import BudgetStop, ImportBudget
from .providers import OpenAIJSON
from .supermemory import Supermemory
from .supermemory_captions import CONTAINER, resolve_hit
from .transcripts import youtube_source
from .youtube_channels import YouTube


class ChannelLibrary:
    def __init__(self, data_dir, *, youtube=None, client_factory=None, llm=None):
        self.data_dir = Path(data_dir)
        self.directory = self.data_dir / "supermemory-trial" / "timed-captions"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.store = ChannelStore(self.data_dir / "channels.sqlite3")
        self.import_budget = ImportBudget(self.data_dir / 'import-budget.json')
        self.youtube = youtube or YouTube()
        self.client_factory = client_factory or (lambda: Supermemory(CONTAINER))
        self.llm = llm or OpenAIJSON()
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.thread = None
        self.answer_lock = threading.Lock()
        self.previews = {}
        self.preview_lock = threading.Lock()
        self._adopt_trial()

    def _adopt_trial(self):
        path = self.directory / "manifest.json"
        if not path.exists():
            return
        manifest = read_json(path)
        if manifest.get("container") != CONTAINER:
            raise ValueError("Existing caption collection belongs to a different container.")
        for video_id, record in manifest.get("sources", {}).items():
            if self.store.rows("SELECT id FROM videos WHERE id=?", (video_id,)):
                continue
            source = read_json(self.directory / f"{video_id}-{record['revision'][:12]}.json")
            self.store.add_video(source)
            self.store.update_video(video_id, state="indexing", document_id=record["document_id"],
                                    revision=record["revision"], segments=len(source["segments"]))

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        import fcntl
        lock = (self.data_dir / "channel-worker.lock").open("a")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            lock.close()
            raise RuntimeError("Another channel worker is using this library.") from None
        self.store.recover()
        self.thread = threading.Thread(target=self._run, args=(lock,), daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=5)

    def preview(self, value):
        from .youtube_channels import channel_url
        channel_url(value)  # Reject arbitrary network targets before entering yt-dlp.
        with self.preview_lock:
            if len(self.previews) > 100:
                self.previews.clear()
        result = self.youtube.preview(value)
        with self.preview_lock:
            self.previews[result["id"]] = (time.monotonic(), result)
        return result

    def add_channel(self, channel_id):
        with self.preview_lock:
            item = self.previews.get(channel_id)
        if not item or time.monotonic() - item[0] > 1800:
            raise ValueError("Find the channel again before importing it.")
        if not os.getenv("SUPERMEMORY_API_KEY"):
            raise ValueError("Configure the indexing provider before importing videos.")
        self.store.add_channel(item[1])
        self.wake.set()
        return {"accepted": True, "channel_id": channel_id}

    def start_ingestion(self, urls=None):
        if not os.getenv("SUPERMEMORY_API_KEY"):
            raise ValueError("Configure the indexing provider before importing videos.")
        if not isinstance(urls, list) or not 1 <= len(urls) <= 20:
            raise ValueError("Supply 1–20 YouTube video links.")
        sources = [youtube_source(url) for url in urls]
        if any(YouTube.is_short({"url": url}) for url in urls):
            raise ValueError("Shorts are excluded. Add a long-form video instead.")
        for source in sources:
            self.store.add_video({**source, "title": source["id"]})
            self.store.execute("UPDATE videos SET state='queued',error=NULL,attempts=0,next_attempt=0 WHERE id=? AND state IN ('error','skipped') AND document_id IS NULL", (source["id"],))
        self.wake.set()
        return {"accepted": True}

    def action(self, channel_id, action):
        self.store.channel_action(channel_id, action)
        self.wake.set()
        return {"accepted": True}

    def status(self):
        result = self.store.status()
        result.update(backend="supermemory", credentials={"indexing": bool(os.getenv("SUPERMEMORY_API_KEY")),
                      "answers": bool(os.getenv("OPENAI_API_KEY"))},
                      worker_running=bool(self.thread and self.thread.is_alive()),
                      answer_model=self.llm.model_name)
        return result

    def _run(self, lock):
        try:
            while not self.stop.is_set():
                try:
                    if self.step():
                        continue
                except Exception:
                    # Per-item failures are persisted in step; keep the worker alive.
                    pass
                self.wake.wait(3)
                self.wake.clear()
        finally:
            lock.close()

    def step(self):
        if not os.getenv("SUPERMEMORY_API_KEY"):
            return False
        self.store.execute("UPDATE channels SET state='queued' WHERE state='idle' AND paused=0 AND synced_at<?", (time.time() - 21600,))
        channels = self.store.rows("SELECT * FROM channels WHERE state='queued' AND paused=0 ORDER BY created_at LIMIT 1")
        if channels:
            channel = channels[0]
            self.store.execute("UPDATE channels SET state='scanning',error=NULL WHERE id=?", (channel["id"],))
            try:
                for video in self.youtube.uploads(channel["id"]):
                    paused = self.store.rows("SELECT paused FROM channels WHERE id=?", (channel["id"],))[0]["paused"]
                    if self.stop.is_set() or paused:
                        self.store.execute("UPDATE channels SET state='queued' WHERE id=?", (channel["id"],))
                        return True
                    self.store.add_video(video, channel["id"])
                self.store.execute("UPDATE channels SET state='idle',synced_at=?,error=NULL WHERE id=?", (time.time(), channel["id"]))
            except Exception:
                self.store.execute("UPDATE channels SET state='error',error=? WHERE id=?", ("Channel discovery could not finish. Discovered videos are saved; retry to continue.", channel["id"]))
            return True
        limited = self.import_budget.enabled
        try:
            ready = self.store.rows("SELECT count(*) n FROM videos WHERE state='ready'")[0]['n'] if limited else 0
            selected = self.import_budget.video_ids(ready) if limited else None
        except BudgetStop as exc:
            self.store.execute('UPDATE channels SET paused=1,error=?', (str(exc),))
            self.import_budget.stop(str(exc))
            return False
        video = self.store.next_video(serial=limited, video_ids=selected)
        if not video:
            return False
        client = None
        try:
            client = self.client_factory()
            if video["document_id"]:
                state = client.document(video["document_id"]).get("status")
                if state == "done":
                    self.store.update_video(video["id"], state="ready", error=None, attempts=0)
                    if limited:
                        # Give asynchronous billing time to settle before another upload.
                        self.store.execute("UPDATE videos SET next_attempt=MAX(next_attempt,?) WHERE state='queued'", (time.time() + 15,))
                elif state == "failed":
                    self.store.update_video(video["id"], state="error", error="The indexing provider could not process this transcript. Retry to recheck its status.")
                else:
                    self.store.update_video(video["id"], state="indexing", next_attempt=time.time() + 30)
                return True
            source_path = self.directory / (video["id"] + "-pending.json")
            source = read_json(source_path) if source_path.exists() else self.youtube.captions(video["id"])
            if YouTube.is_short(source):
                raise ValueError("Shorts are excluded. Add a long-form video instead.")
            if source["id"] != video["id"]:
                raise ValueError("Caption identity does not match the queued video.")
            write_json(source_path, source)
            canonical = self.directory / f"{source['id']}-{source['revision'][:12]}.json"
            write_json(canonical, source)
            content = f"Video: {source['title']}\nYouTube captions; not human verified.\n\n" + "\n".join(f"[{s['id']}] {s['text']}" for s in source["segments"])
            if len(content.encode()) > 1_000_000:
                raise ValueError("Transcript exceeds the indexing text limit; split this video before importing.")
            if limited:
                self.import_budget.authorize(client, content)
            # Recheck a user pause after downloading captions, before submitting them.
            if not self.store.rows("SELECT id FROM videos v WHERE id=? AND " + self.store.eligible(), (video['id'],)):
                self.store.update_video(video['id'], state='queued')
                return False
            # Stable ID makes retries after a lost response refer to the same document.
            result = client.add(content, f"kr-captions-{source['id']}-{source['revision'][:12]}",
                                {"video_id": source["id"], "video_url": source["url"], "revision": source["revision"],
                                 "title": source["title"], "caption_language": source["language"],
                                 "timestamp_kind": source["timestamp_kind"], "human_verified": False})
            document_id = result.get("id")
            if not isinstance(document_id, str) or not document_id:
                raise RuntimeError("The indexing provider returned no document ID.")
            self.store.execute("UPDATE videos SET title=? WHERE id=?", (source["title"], source["id"]))
            self.store.update_video(video["id"], state="indexing", document_id=document_id,
                                    revision=source["revision"], segments=len(source["segments"]),
                                    attempts=0, next_attempt=time.time() + 15, error=None)
        except BudgetStop as exc:
            self.store.update_video(video['id'], state='queued', error=None)
            self.store.execute("UPDATE channels SET paused=1,error=?", (str(exc),))
            self.import_budget.stop(str(exc))
            return False
        except ValueError as exc:
            self.store.update_video(video["id"], state="skipped", error=str(exc)[:400])
        except Exception:
            if limited:
                reason = 'Limited import paused after a provider error. Check credits and the failed video before retrying.'
                self.store.update_video(video['id'], state='error', error=reason)
                self.store.execute('UPDATE channels SET paused=1,error=?', (reason,))
                self.import_budget.stop(reason)
                return False
            attempts = video["attempts"] + 1
            self.store.update_video(video["id"], state="error" if attempts >= 3 else ("indexing" if video["document_id"] else "queued"),
                                    attempts=attempts, next_attempt=time.time() + min(300, 30 * 2 ** attempts),
                                    error="Could not reach YouTube or the indexing provider. Retry after checking connectivity and provider limits.")
        finally:
            if client is not None:
                client.session.close()
        return True

    def search(self, question, source_id=None, progress=None):
        from .answers import nonempty_text
        question = nonempty_text(question, "question", 6000)
        if source_id is not None and not isinstance(source_id, str):
            raise ValueError("Invalid video selection.")
        records = self.ready_videos()
        available = {r["id"]: r for r in records}
        if source_id and source_id not in available:
            raise ValueError("Selected video is not ready to search.")
        if not available:
            return {"excerpts": []}
        client = self.client_factory()
        try:
            filters = {"AND": [{"key": "video_id", "value": source_id}]} if source_id else None
            raw = client.search(question, limit=8, filters=filters)
        finally:
            client.session.close()
        citations, seen = [], set()
        for hit in raw.get("results", []):
            video_id = (hit.get("metadata") or {}).get("video_id")
            record = available.get(video_id)
            if not record or (source_id and video_id != source_id):
                continue
            source = read_json(self.directory / f"{video_id}-{record['revision'][:12]}.json")
            for cite in resolve_hit(hit, source):
                key = (video_id, tuple(cite["segment_ids"]))
                if key not in seen:
                    citations.append(cite)
                    seen.add(key)
        return {"excerpts": citations}

    def ready_videos(self):
        return self.store.rows("SELECT * FROM videos WHERE state='ready'")

    def page(self, offset=0, *, status=""):
        return self.store.page(offset, status=status)

    def answer(self, question, source_id=None, *, progress=None):
        if not self.answer_lock.acquire(blocking=False):
            raise ValueError("Another answer is being prepared. Please try again shortly.")
        try:
            if progress:
                progress({"type": "stage", "phase": "search", "message": "Searching the original conversations…"})
            retrieved = self.search(question, source_id, progress=progress)
            citations = retrieved["excerpts"]
            if progress and citations:
                progress({"type": "stage", "phase": "review", "message": "Checking source clips against the original transcripts…"})
            sources = {}
            for cite in citations:
                if cite["source_id"] not in sources:
                    record = self.store.rows("SELECT revision FROM videos WHERE id=?", (cite["source_id"],))[0]
                    sources[cite["source_id"]] = read_json(self.directory / f"{cite['source_id']}-{record['revision'][:12]}.json")
            audit = {"retrieval": retrieved.get("retrieval", {})}
            options = {"max_repairs": self.answer_repairs} if hasattr(self, "answer_repairs") else {}
            if getattr(self, 'answer_strategy', '') == 'video_guide':
                options['allow_closest'] = getattr(self, 'allow_closest', True)
                options['progress'] = progress
            if getattr(self, 'isolate_reference_summaries', False):
                options['isolate_summaries'] = True
            if retrieved.get("clarifying_question"):
                result = {"status": "needs_clarification", "message": retrieved["clarifying_question"], "points": []}
                audit["final_status"] = "needs_clarification"
            else:
                if progress and citations and getattr(self, 'answer_strategy', '') != 'video_guide':
                    progress({"type": "stage", "phase": "compose", "message": "Preparing and checking your answer…"})
                generate = {'video_guide': recommend_moments, 'isolated_statements': answer_from_evidence}.get(
                    getattr(self, 'answer_strategy', ''), answer_captions)
                result = generate(question, citations, sources, self.llm, audit=audit, whole_passages=True, **options)
            if result["status"] == "invalid_evidence" or getattr(self, "read_only", False):
                # Keep every reader attempt for evaluation, never display rejected drafts.
                directory = self.data_dir / "response-diagnostics"
                try:
                    directory.mkdir(parents=True, exist_ok=True)
                    diagnostic = json.dumps({"question": question, "model": self.llm.model_name,
                                             "audit": audit, "citations": citations, "final": result}, ensure_ascii=False)
                    for key in ("OPENAI_API_KEY", "GROQ_API_KEY", "SUPERMEMORY_API_KEY", "DEEPGRAM_API_KEY", "HF_TOKEN"):
                        if os.getenv(key):
                            diagnostic = diagnostic.replace(json.dumps(os.environ[key], ensure_ascii=False)[1:-1], "[redacted]")
                    diagnostic_id = str(time.time_ns())
                    write_json(directory / f"{diagnostic_id}.json", json.loads(diagnostic))
                    result["diagnostic_id"] = diagnostic_id
                except OSError:
                    pass
            return result
        finally:
            self.answer_lock.release()
